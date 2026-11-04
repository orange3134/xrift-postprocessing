# 画面仕上げのレシピ

各GLSL断片は `Finish.tsx` の同名uniform・`eyeUV`・`localUv` を使う抜粋。単独の完全なShaderMaterialではない。import、uniform、パス接続を含む実装は [Finish.tsx](../assets/sample/components/Finish.tsx)。この資料の値は2026-11-04のHELIOSプリセットであり、他の世界の推奨値ではない。

## ブルーム

縦横約1/4解像度へ5点平均で縮小し、soft kneeで明部抽出、横・縦のガウスぼかし、線形HDRへ加算する。3パス、追加ターゲット2枚。現在の `threshold=.71, strength=.6, radius=4, knee=.91` は強めの作品設定。

```glsl
// cは5点平均したHDR色。kneeの単位はこの実装ではHDR輝度幅。
float bright = max(c.r, max(c.g, c.b));
float knee = clamp((bright-uThreshold+uKnee)/max(2.*uKnee,.0001),0.,1.);
float contribution = max(bright-uThreshold,knee*knee*uKnee*.5)/max(bright,.0001);
gl_FragColor = vec4(c*contribution,1.);
```

[bloom.ts](../assets/sample/lighting/bloom.ts) の核生成は、隣接2画素の重みを線形補間1回へまとめる。

```ts
export function bloomKernel(radius: number) {
  const sigma = Math.max(.4, Math.min(6.4, 1.6 * radius))
  const g = (x: number) => Math.exp(-x*x / (2*sigma*sigma))
  const weights = new Float32Array(13), offsets = new Float32Array(13)
  weights[0] = 1
  let sum = 1
  for (let i=1; i<=12; i++) {
    const x=i*2-1, a=g(x), b=g(x+1), w=a+b
    weights[i]=w; offsets[i]=w>0 ? x+b/w : x; sum+=2*w
  }
  for (let i=0; i<weights.length; i++) weights[i]/=sum
  return {weights, offsets}
}
```

```glsl
vec3 c = texture2D(uImage,vUv).rgb*uWeights[0];
for (int i=1;i<13;i++) {
  vec2 offset=uStep*uOffsets[i];
  c += (texture2D(uImage,eyeUV(vUv+offset,vUv)).rgb
      + texture2D(uImage,eyeUV(vUv-offset,vUv)).rgb)*uWeights[i];
}
// 横: uStep=(1/width,0)、縦: uStep=(0,1/height)
```

注意:

- 少数のサンプルの間隔だけをradius倍すると隙間ができ、明るい輪郭が2重・3重になる。幅はsigmaと重みで変え、隣接テクセルの被覆を維持する。さらに大きい範囲は縮小段数や核の支持範囲を設計し直す。この核はradius 4付近を想定している。
- ペアリングは線形フィルタ前提。重みの `w0 + 2*sum(wi) = 1` とインパルス応答の単調減少を確認する。
- 閾値と露出は別物。この構成では抽出後に露出を掛けるため、露出変更が抽出閾値へ自動反映されない。
- 水面スペキュラーや太陽のHDR輝度が高すぎると巨大な白い塊になる。マテリアル側の輝度・面積も調整する。
- radiusは低解像度ピクセル基準で、画面サイズやDPRに対し厳密な画角一定ではない。
- 強度0だけでは同梱コードの3パスは止まらない。性能が必要ならpass skipと古いテクスチャを参照しない条件を一緒に追加する。

## 色収差

中心からの距離に応じてR/Bを逆方向へずらし、Gを中心に保つ。`aberration=5, falloff=1`。

```glsl
vec2 radial = localUv-.5;
vec2 shift = radial*pow(max(length(radial),.0001),uFalloff)
           *uAberration/uSize*uEffects;
vec3 c = vec3(texture2D(uScene,eyeUV(vUv+shift,vUv)).r,
              texture2D(uScene,vUv).g,
              texture2D(uScene,eyeUV(vUv-shift,vUv)).b);
```

`uSize` は横並び全体の実ピクセル寸法。中心は各眼の `localUv` で作る。`aberration` は端の移動量そのものではなく係数。細線、アバターの顔、文字で色ずれを確認し、XRでは個別に弱める判断もする。眼境界のclampを省かない。

## カラー補正・露出・トーンマッピング

現在値: exposure `.88`、saturation `1.04`、contrast `1.02`、temperature `.03`、tint `0`、turquoise `.09`、shadowLift `1.4`、gradeMix `1`、gamma `.9`。

```glsl
vec3 graded=c*vec3(1.+uTemperature,1.+uTemperature*.6,1.-uTemperature)
             *vec3(1.+uTint*.5,1.-uTint,1.+uTint*.5);
graded.g+=max(0.,graded.b-graded.r)*uTurquoise;
float luma=dot(graded,vec3(.2126,.7152,.0722));
graded=mix(vec3(luma),graded,uSaturation);
graded+=vec3(.001,.004,.004)*uShadowLift*(1.-smoothstep(.02,.4,luma));
graded=(graded-.18)*uContrast+.18;
// ACES風の簡易曲線。完全なACES色管理ではない。
vec3 x=max(vec3(0.),mix(c,graded,uEffects*uGradeMix))*uExposure;
c=clamp((x*(2.51*x+.03))/(x*(2.43*x+.59)+.14),0.,1.);
c=pow(max(c,vec3(0.)),vec3(1./uGamma));
```

temperatureはケルビン値ではなくRGB係数。gammaは作品の調整値であり、sRGB変換の代替ではない。`gamma>0` を保証する。グレードはHDR段階、表示色空間変換は最後のホスト出力で一度だけ行う。この曲線を使うならレンダラーのtoneMappingは `NoToneMapping` にする。ホストのACES/AgXを選ぶ設計なら自前filmicを削除して、出力経路を一貫させる。

この実装の仕上げOFFはグレード・bloom等を外すが、露出・filmic・調整gamma・FXAAは残す。OFF比較を「未処理HDR」と呼ばない。完全なカラー補正なしの比較が必要なら exposure=1、gamma=1 の基準を別途定義する。物体の黒さがベイク・法線・材質に由来する場合、全画面shadowLiftだけで直そうとしない。

## ビネット

`strength=.14, radius=.62, softness=.42`。トーンマッピング後、左右眼の局所UVから周辺を暗くする。

```glsl
float radius=length((localUv-.5)*vec2(1.25,1.))*1.4142;
c*=1.-uVignetteStrength*smoothstep(
  uVignetteRadius-uVignetteSoftness,
  uVignetteRadius+uVignetteSoftness,radius)*uEffects;
```

`1.25` はこの作品の楕円比。画面アスペクト補正として普遍的な値ではない。縦長・超横長・各眼viewportで見直す。softnessは正、strengthは0〜1。暗い室内やXRで周辺が黒く潰れないか確認する。安全領域を狭めるような強い設定を初期値に流用しない。

## フィルムグレイン

`strength=.018, size=1.2, speed=18`。サイズは実描画ピクセル単位、speedはノイズ更新頻度（0で静止）。暗部・明部を弱め中間調に乗せる。

```glsl
float filmGrain(vec2 cell,float frame) {
  uvec3 p=uvec3(vec3(cell,mod(frame,65536.)));
  uint h=p.x*1973u+p.y*9277u+p.z*26699u+911u;
  h=(h^(h>>16u))*0x7feb352du;
  h=(h^(h>>15u))*0x846ca68bu; h=h^(h>>16u);
  return float(h&0x00ffffffu)/16777216.-.5;
}
vec2 cell=floor(localUv*uSize/vec2(mix(1.,2.,uStereo),1.)/max(.5,uGrainSize));
float noise=filmGrain(cell,floor(uTime*uGrainSpeed));
float mask=.28+.72*sin(clamp(dot(c,vec3(.2126,.7152,.0722)),0.,1.)*3.14159);
c=max(vec3(0.),c+noise*uGrainStrength*mask*uEffects);
```

過去に簡単なノイズを強めると斜めの規則模様が出た。整数ハッシュに変更した実装を使い、強度を一時的に上げて方向性・縞を検出する。`uint` とビット演算を使うためWebGL2/対応するシェーダー変換が前提。左右眼に同じ局所ピクセル基準を使う。これは画面に貼り付く粒であり、立体空間の粒子ではない。最終FXAAで粒が少し弱まる。順番を変えるならAAと粒の見た目を再検証する。

## FXAA

フル解像度で最後に一度だけ処理し、ホストの `write` を入力、`read` を出力に再利用する。

```ts
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js'
const fragment = FXAAShader.fragmentShader
  .replace('texture( tex2D, uv )', 'texture( tex2D, eyeUV(uv,vUv) )')
  .replace('_SubpixelBlending = 1.0', '_SubpixelBlending = 0.5')
// shader() はFinish.tsxの共通factory。eyeUVのGLSLも追加する。
const aa = shader(fragment, THREE.UniformsUtils.clone(FXAAShader.uniforms))
aa.uniforms.resolution.value.set(1/width,1/height)
```

上流GLSLの文字列置換に依存する。更新時は該当文字列が存在するか、全てのtexture fetchがclampされるか確認する。置換が失敗してもJSは例外を出さない。必要なら版を固定した局所ヘルパーへ明示的に改変する。FXAAはジオメトリの輪郭向けで、specularの時間的ちらつき全体やシャフトの明滅を直すものではない。細い葉・文字・グレインがぼけすぎないか見る。サンプルでは出力変換前のtone-mapped linear値で輝度を計算しており、他の色空間のFXAA設定を無条件に流用しない。
