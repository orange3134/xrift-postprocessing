# 統合・HDR・XR

## ホストとの契約

サンプルの抽出元は Three.js 0.183.1、R3F 9.5.0、React 19.2.4、`@xrift/world-components` 0.60系。将来のAPI保証ではない。インストール済みソースを確認する。

```json
{
  "world": {
    "outputBufferType": "HalfFloatType"
  }
}
```

これは既存の `xrift.json` の `world` へマージする差分。既存のワールド設定を丸ごと消さない。開発側も `DevEnvironment` の `outputBufferType` に同じ値を渡す。

この版の `setEffects()` はレンダラー生成時の `outputBufferType` が `UnsignedByteType` だと動かない。メソッドが存在するだけでは十分でない。サンプル内の中間ターゲットのRGBA8フォールバックは、ホストのHDR非対応を解決するものではない。HDR生成設定を変更できないホストでは本経路を無効にし、対応するホストの拡張点を検討する。

`setEffects([effect])` は既存チェーン全体を置換する。サンプルはワールドが唯一の所有者という前提で、終了時に `setEffects(null)` を呼ぶ。既存のComposer・ホスト効果がある場合は所有者側へ登録処理を集約する。公開getterがないのに復元可能と仮定しない。同じレンダラーへ複数の `Finish` をマウントしない。

## パスとswap

```text
ホスト: メインシーン → read（線形HDR＋深度）
  ├─ 明部抽出 → bloom A → 横ぼかし B → 縦ぼかし A
  └─ 空の可視マスク → 横/縦ぼかし → 放射状積分 → 時間補間
統合: 色収差でreadを取得 → フォグ → bloom/shaft加算
    → カラー補正 → 露出・フィルミック → 調整ガンマ
    → ビネット → グレイン → write
FXAA: write → read
ホスト: read → 表示色空間変換 → canvas/XR出力
```

`effect.render(renderer, write, read)` はこの順番。サンプルは最終結果を `read` に戻すため `needsSwap: false`。単一パスで `write` に出す設計なら通常は `needsSwap: true`。書き込み先のテクスチャを同時に入力として読むフィードバックループを作らない。独自の `OutputPass` を重ねない。

フルスクリーンの材質は `depthTest:false`、`depthWrite:false`、`toneMapped:false`。反射・屈折・空生成などのオフスクリーン画像に最終カラー補正を焼き込まない。メイン3Dシーンの追加描画は不要で、追加されるのはフルスクリーンパスだけ。

## 状態復元のサンプル

以下はパスを実行する関数の骨格。`drawPasses` は呼び出し側で提供する。

```ts
import * as T from 'three'
function withPostState(gl: T.WebGLRenderer, drawPasses: () => void) {
  const saved = {
    target: gl.getRenderTarget(), tone: gl.toneMapping, xr: gl.xr.enabled,
    viewport: gl.getViewport(new T.Vector4()),
    scissor: gl.getScissor(new T.Vector4()), test: gl.getScissorTest(),
  }
  try {
    gl.xr.enabled = false // フルスクリーン処理の間だけ
    gl.setScissorTest(false)
    gl.toneMapping = T.NoToneMapping
    drawPasses()
  } finally {
    gl.setRenderTarget(saved.target)
    gl.setViewport(saved.viewport)
    gl.setScissor(saved.scissor)
    gl.setScissorTest(saved.test)
    gl.xr.enabled = saved.xr
    gl.toneMapping = saved.tone
  }
}
```

clear色・alpha・autoClear・shadow設定などを追加で変更するなら、それらも復元する。マウント前のtoneMappingも保存してアンマウント時に戻す。

## 左右眼の分離

この実装は同じサイズの左右眼が1枚のテクスチャに横並びとなる配置を前提にする。`ArrayCamera` の存在だけで任意のXR出力が同じ配置と断定しない。ホストの眼viewportを確認し、異なる配置・texture array・multiviewでは座標系とリソースを作り替える。

```glsl
// uStereo: 0=mono, 1=左右横並び。halfPixelは「入力」テクスチャの値。
vec2 eyeUVSized(vec2 p, vec2 center, vec2 halfPixel) {
  if (uStereo > .5) {
    float lo = step(.5, center.x) * .5;
    p.x = clamp(p.x, lo + halfPixel.x, lo + .5 - halfPixel.x);
  }
  return clamp(p, halfPixel, vec2(1.) - halfPixel);
}
vec2 localUv = vec2(uStereo > .5 ? fract(vUv.x * 2.) : vUv.x, vUv.y);
```

フル解像度・ブルーム・シャフト・履歴の半テクセル幅は別々に `.5 / width, .5 / height` で計算する。DPR込みの実描画サイズを `setSize(w,h)` から受け取り、CSSピクセルを使わない。色収差、ぼかし、FXAA、再投影の全サンプルに眼境界処理を適用する。

縮小ターゲット幅は偶数に丸め、左右境界をテクセル境界に一致させる。同梱版はブルームにもこの丸めを追加してある（元コードではシャフト側のみ偶数化）。例: 幅 `Math.max(2, Math.ceil(w / 8) * 2)`、高さ `Math.max(1, Math.ceil(h / 4))`。

## 同梱コードの移植

`assets/sample/` を対象の `src/postprocessing/` などへ相対構造を保ってコピーする。依存関係:

| ファイル | 役割・依存 |
|---|---|
| `components/Finish.tsx` | R3F、Three.js、FXAAShader、下記の設定・3モジュール |
| `lighting/bloom.ts` | 正規化ガウス核。依存なし |
| `lighting/shaftTemporal.ts` | Three.js。単体で再利用可能 |
| `lighting/aerialPerspective.ts` | Three.js、SUN、設定、空オブジェクトとの契約 |
| `components/Atmosphere.tsx` | R3F、Three.js、SUN。任意の空生成例 |
| `constants.ts` | 太陽方向。対象ワールドのライトと一致させる |
| `finishSettings.ts` | HELIOSプリセット。現在の完成値 |

```tsx
// 既存のR3F Canvas / XRiftホストの内側へ一度だけ配置する。
import { Atmosphere } from './postprocessing/components/Atmosphere'
import { Finish } from './postprocessing/components/Finish'
export function WorldPostProcessing() {
  return <><Atmosphere /><Finish /></>
}
```

`Atmosphere` はポストプロセスそのものではなく補助リソース。既存Skyboxがある場合に無条件で追加して空を二重にしない。既存の空を使うなら `createAerialState` の名前検索を明示的な入力へ変更する。必要なのは雲あり線形HDR `uSky`（alphaは太陽の透過率）、雲なし線形HDR `uAirlight`、空のworld行列、太陽方向。同梱コードは `daylight-atmosphere` というmesh名と半径450mを共通契約にしている。半径変更時は空のgeometry、空への交点計算、太陽のworld位置を全て更新する。観測者がドーム内部にいる前提も確認する。

`Finish` の `helios-postprocessing` というgroup名は開発ブリッジ用。変更するならブリッジも一致させる。見た目の初期値は `finishSettings.ts` を編集する（材質作成時の仮のuniform値ではない）。

`FXAAShader` は `three/addons/shaders/FXAAShader.js` からimportする。このサブパスはXRiftの共有ローダー一覧に含まれず、ワールドへバンドルされる前提。`three/addons` 全体を共有扱いにしない。追加ライブラリを使う場合も共有可否・生成物のセキュリティ検査を確認する。

## ライフサイクル

render target、material、geometry、履歴を解放する。ホスト所有のcolor/depth targetや共有textureを `dispose()` しない。`Scene.onBeforeRender` は以前のcallbackを呼び、自分がまだ所有する場合だけ復元する。

サンプルは既存アプリでの通常マウント用の抽出例。React StrictModeのsetup→cleanup→setupやHMRで、`useMemo` の同じGPUリソースをcleanup後に使い回さないか実際に確認する。必要ならeffect内で生成・登録・解除を対にする。複数のパッチを重ねる環境ではcallback所有者を集約する。これらを満たしていない環境へ未調整のまま投入しない。
