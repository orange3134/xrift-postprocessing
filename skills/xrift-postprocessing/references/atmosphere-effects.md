# 遠景フォグ・ライトシャフト

完全なGLSL・CPU状態管理は [aerialPerspective.ts](../assets/sample/lighting/aerialPerspective.ts)、[shaftTemporal.ts](../assets/sample/lighting/shaftTemporal.ts)。以下の断片は同梱 `Finish.tsx` のuniform、`eyeUV`、左右横並び配置を前提にする。

## 深度の取得・距離復元

3Dシーンをもう一度描かず、メインHDRターゲットの深度を使う。`Scene.onBeforeRender` はこの版のThree.js実装で第4引数がrender targetだが、型定義はObject3Dのgeometry/material型を継承しているため、局所的な型変換が必要。

メインcamera、またはXRの主ArrayCameraの描画だけで行列を更新する。水面反射・環境プローブのcameraで眼の行列を上書きしない。元callbackを呼ぶこと、終了時に自分のcallbackだけを外すことも必要。

```ts
// createAerialState内。attachmentsはこの処理が作った深度だけを保持するMap。
if (!target.depthTexture) {
  const depth = new T.DepthTexture(target.width, target.height,
    target.stencilBuffer ? T.UnsignedInt248Type : T.UnsignedIntType)
  depth.format = target.stencilBuffer ? T.DepthStencilFormat : T.DepthFormat
  target.depthTexture = depth
  attachments.set(target, depth)
  renderer.setRenderTarget(target) // この版では再bindでアタッチメントを更新
}
// cleanup: target自体はホスト所有。
for (const [target, depth] of attachments) {
  if (target.depthTexture === depth) target.depthTexture = null
  depth.dispose()
}
attachments.clear()
```

既存の `target.depthTexture` は再利用し、所有権を取得しない。ターゲットにdepthBufferがない・空リソースがない場合は `uDepthReady=0` にしてフォグとシャフトを停止する。MSAAや別版の再bind仕様、resize後のアタッチメント更新は実描画でも確認する。テストのmock rendererはGPUアタッチメントの正しさまで証明しない。

```glsl
int eye = uStereo>.5 && uv.x>=.5 ? 1 : 0;
vec2 local = vec2(uStereo>.5 ? fract(uv.x*2.) : uv.x, uv.y);
vec4 p = uInverseProjection[eye] * vec4(local*2.-1.,depth*2.-1.,1.);
vec3 viewPosition = p.xyz/p.w;
float distance = length(viewPosition);
```

near/farの定数近似ではなく実際の各眼の逆射影行列を使う。コードは通常のWebGL深度（clear=1、NDC z=-1〜1）前提。reverse depth・logarithmic depthでは空判定と復元式を合わせて変更する。空ドームは `depthWrite:false`、不透明・alphaTest葉は通常のメイン描画の深度を使うため、頂点アニメーションと遮蔽が一致する。

## 遠景フォグ

開始距離40m、濃度 `.005`。指数 `1.35` は見た目の調整で、物理的な一様媒質の厳密解ではない。

```glsl
vec3 aerialFog(vec3 color,vec2 uv) {
  float depth=texture2D(uDepth,uv).r;
  if(uDepthReady<.5 || depth>=1. || uFogDensity<=0.) return color;
  float distance=length(aerialView(uv,depth));
  float fog=1.-exp(-pow(max(0.,distance-uFogStart)*uFogDensity,1.35));
  vec3 d=aerialSkyDirection(uv);
  vec2 airUv=vec2(atan(d.z,d.x)/6.28318530718+.5,
                  asin(clamp(d.y,-1.,1.))/3.14159265359+.5);
  return mix(color,texture2D(uAirlight,airUv).rgb,fog);
}
```

注意:

- 雲を含む `uSky.rgb` を混ぜると岩の表面に雲の模様が出て、雲が岩を貫通したように見える。**雲を含まない大気色 `uAirlight` を別に作る**。同梱 `Atmosphere` は雲あり2048×1024、雲なし256×128を起動時に一度だけ生成する。空自体にはフォグを掛けない。
- 静的な空を前提にした一回生成。太陽や天候を動かすワールドでは空とairlightを整合させて更新する。毎フレーム高負荷の空積分を安易に追加しない。
- ドーム原点から離れると単純なカメラ方向だけでは太陽位置がずれる。`aerialSkyDirection` は実際の450mドームとの交点を逆world行列で求める。別の無限遠空・キューブマップならその空の投影方式に合わせる。
- 半透明で `depthWrite:false` の水面やガラスは背後の不透明物の深度になる。水そのものの距離で正確に霧を計算するにはマテリアル側のフォグや別深度の設計が必要。書き込みONへの変更だけで直そうとすると透過順序が壊れうる。
- 40mはworld距離。親groupのscaleを変えた世界では意図したスケールに調整する。

## ライトシャフト

線形HDRの白い物体全体を光源にせず、太陽付近の遮蔽されていない空だけを使う。現在値は `strength=.32, radius=.06, length=1, blur=.1`。

```glsl
// mask pass: d=空ドーム方向、sky.a=雲を透過する太陽光の割合。
float angular=length(d-uSunDirection);
float aperture=exp(-angular*angular/max(.0001,uShaftRadius*uShaftRadius));
float visible=0.;
for(int y=0;y<4;y++) for(int x=0;x<4;x++) {
  vec2 offset=(vec2(float(x),float(y))-1.5)*uHalfPixel*2.;
  visible+=step(1.,texture2D(uDepth,eyeUV(vUv+offset,vUv)).r);
}
visible*=uDepthReady/16.;
gl_FragColor=vec4(vec3(aperture*sky.a*visible),1.);
```

1/4解像度でマスク生成→横ぼかし→縦ぼかし→放射状積分→時間補間の合計5パス。4×4の元深度サンプルで可視率を平均し、細い葉が1画素の判定を急変させるのを抑える。最終画像だけをぼかすより、**積分前の光源マスク**をぼかす方が、筋全体が突然現れる現象を抑えられる。

```glsl
// 横/縦のsource-mask blur。uStepはblur / maskSize。
float v=texture2D(uImage,vUv).r*.227027027;
v+=(texture2D(uImage,eyeUV(vUv+uStep*1.384615385,vUv)).r
  + texture2D(uImage,eyeUV(vUv-uStep*1.384615385,vUv)).r)*.316216216;
v+=(texture2D(uImage,eyeUV(vUv+uStep*3.230769231,vUv)).r
  + texture2D(uImage,eyeUV(vUv-uStep*3.230769231,vUv)).r)*.070270270;
```

```glsl
// radial pass。sun.xyは各眼を全体texture上に投影した座標。
vec2 delta=(sun.xy-vUv)*uShaftLength/64.;
vec2 p=vUv; float sum=0.,weight=1.,total=0.;
for(int i=0;i<64;i++) {
  p+=delta;
  if(p.x>lo && p.x<hi && p.y>0. && p.y<1.)
    sum+=texture2D(uMask,eyeUV(p,vUv)).r*weight;
  total+=weight; weight*=.985;
}
gl_FragColor=vec4(vec3(sum/total*sun.z),1.);
```

`lo/hi` はその眼の範囲。画面外をclampして何度も足すと端の輝度が線として引き伸ばされるため、範囲外は加算0にする。分母totalは増やして自然に減衰させる。太陽が背後なら `sun.z=0`。投影端 `.85〜1.2` の間でフェードし、両眼とも有効光源がなければ全5パスを止め、合成強度を0にする。

これはscreen-spaceの近似であり、画面外の遮蔽物や本当の空間的な体積散乱を再現しない。太陽方向は空・照明・反射で共通化する。白い床や水のハイライトから筋が発生していないことも確認する。

## 時間補間：葉のちらつきを抑える

現在の時定数は `.3` 秒（`.3`秒で約63%、1秒で約96%追従）。固定の混合係数ではなくフレーム時間から重みを計算する。

```ts
export function shaftHistoryWeight(delta: number, seconds: number) {
  return seconds>0 && delta>0 && delta<.25 ? Math.exp(-delta/seconds) : 0
}
// GPU: result = mix(current, reprojectedHistory, historyWeight)
```

```glsl
// 回転だけで履歴を再投影。directionなのでw=0で平行移動を除く。
vec4 view=uInverseProjection[eye]*vec4(local*2.-1.,0.,1.);
vec3 ray=mat3(uCameraWorld[eye])*normalize(view.xyz/view.w);
vec4 previous=uPreviousViewProjection[eye]*vec4(ray,0.);
vec2 uv=previous.xy/max(previous.w,.00001)*.5+.5;
// previous.w<=0や眼の外ならweight=0。左右の局所UVをatlas UVに戻す。
if(uStereo>.5) uv.x=(uv.x+float(eye))*.5;
float history=texture2D(uHistory,eyeUV(uv,vUv)).r;
gl_FragColor=vec4(vec3(mix(current,history,weight)),1.);
```

低解像度の履歴2枚をping-pongし、シャフトの明るさだけを平滑化する。メイン画面や水面全体を履歴と混ぜない。最新を出力した後でread/writeを入れ替え、行列をcommitする。

同梱状態管理の履歴拒否条件:

- 初回、リサイズ、効果OFF、太陽が無効、XR/mono切り替え。
- deltaが0以下または `.25` 秒以上（タブ停止など）。
- 視線方向が約 `.25` rad以上変わるカット、射影行列の変化（FOVなど）。
- 平行移動速度 `.02〜.6 m/s` で履歴を弱め、`.6`以上で破棄。左右眼で別々に判定。
- 再投影が画面外・背後ならその画素の履歴を使わない。

回転だけの再投影では遮蔽の奥行きや並進を再現できないため移動で捨てる。歩行時には平滑化が弱くなり、ちらつきとのトレードオフがある。値はworldスケール依存。太陽方向・空・シャフト形状の設定を急変更する機能を足すなら、その変更でもresetする（元コードは全設定変更を自動検知しない）。全画面TAAやmotion vectorを実装済みとは扱わない。
