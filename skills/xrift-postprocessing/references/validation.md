# 検証・調整UI・既知の問題

## 調整UIの分離

設定型・初期値・uniform更新は本番側、DOMのスライダーや数値入力は開発側。`World` から開発UIをimportしない。単に非表示にするだけでは公開チャンクから除外できない。

同梱Finishのgroupを使う開発ブリッジ例（R3Fの内側、devエントリーのみからimportする）:

```tsx
import { useFrame } from '@react-three/fiber'
import type { FinishSettings } from './postprocessing/finishSettings'
export function DevFinishBridge({ settings, enabled }: {
  settings: FinishSettings; enabled: boolean
}) {
  useFrame(({ scene }) => {
    const state = scene.getObjectByName('helios-postprocessing')?.userData
    if (state) {
      Object.assign(state.settings, settings)
      state.enabled = enabled
    }
  }, -.2)
  return null
}
```

UIのstateは `{...FINISH_DEFAULTS}` で初期化し、スライダーと数値入力を同じ値へ同期する。空欄や負号の入力途中を毎キーで潰さず、draft文字列を別に持ち、確定時にfinite判定・範囲clampをする。初期値へ戻すボタンと読み取り専用JSON表示を用意すると、見ながら決めた値をコードへ転記しやすい。ブラウザ内の一時調整と、保存されたプリセットを区別する。

HELIOSの操作範囲（移植先の強制上限ではない）:

| 効果 | 範囲 |
|---|---|
| bloom | threshold 0〜4、strength 0〜.6、radius .25〜4、knee 0〜1 |
| 色収差 | amount 0〜16、falloff 0〜6 |
| grade | exposure .1〜2.5、saturation 0〜2、contrast .5〜1.6、temperature -.2〜.2、tint -.15〜.15、turquoise 0〜.4、shadowLift 0〜4、mix 0〜1、gamma .5〜1.8 |
| vignette | strength 0〜1、radius .1〜1.5、softness .05〜1 |
| grain | strength 0〜.15、size .5〜4、speed 0〜60 |
| shaft | strength 0〜3、blur 0〜4、smoothing 0〜1.5秒、radius .02〜.2、length .2〜1 |
| fog | start 0〜150m、density 0〜.03 |

固定視点は「葉越しの太陽」「開けた太陽」「太陽と反対」「遠景」を用意し、自由歩行も確認する。固定cameraの毎フレーム書き換えを歩行モードに残さず、ホストのプレイヤーcameraへ制御を戻す。プレビューHTMLを分ける場合もUIが公開Worldへ辿られないようにする。

## 実行する確認

1. `npm run typecheck` と `npm run build`。FXAAの文字列置換箇所とシェーダーのcompileログも確認する。
2. 同梱数値検査を対象プロジェクトのルートで実行する。`<skill-directory>` はインストールされたスキルの実パスへ置き換える（例: `.agents/skills/xrift-postprocessing`）。

   ```powershell
   node "<skill-directory>/scripts/check-samples.mjs"
   ```

   `three` と `esbuild` が対象プロジェクトから解決できることが必要。テストは同梱サンプルに対して実行し、成果物を対象の `.cache/xrift-postprocessing-check/` に書く。移植後の実装を検査する場合は、サンプルと同じ構造のソースルートを引数で指定する。

   ```powershell
   node "<skill-directory>/scripts/check-samples.mjs" "./src/postprocessing"
   ```

3. 実ブラウザでGPUシェーダーのエラー、黒画面・NaN・白飛び、ウィンドウresize、DPR変更、OFF/ON、アンマウント／再入場を確認する。StrictMode/HMRを使うプロジェクトでは再setupも確認する。
4. 公開用のModule Federationエントリー経由でも同じ効果が出ることを確認する。開発版だけ成功して完了としない。`xrift check world --json` が利用可能ならビルド後に実行する（アップロードではない）。
5. `dist` の本番Worldから到達可能なJSを調べ、調整UIコンポーネント名・ラベルが混ざっていないことを確認する。別途ビルドされた開発HTML/JSがある場合は、公開対象から除外されることも確認する。
6. XR実機では左右の境界・中心・深度、片眼ごとの太陽位置、文字の可読性、頭を振る／歩く際の残像、フレーム時間を測る。PCブラウザのみならその限界を報告する。

## 効果ごとの観測項目

| 効果 | 見るもの |
|---|---|
| bloom | 半径最大で明るい輪郭が分裂しない、強度0で消える、白い床や水面を潰さない |
| 色収差 | 中央は小さく端で増加、R/Bのずれ、眼の境界に反対眼が混じらない |
| grade/tone map | 白・中間灰・黒の階調、肌・砂・水の色、ON/OFFの意味、二重変換なし |
| vignette | 各眼中心、縦横比、暗いシーンの端の潰れ |
| grain | 一時的に強めて斜め縞・規則模様を検出、速度0で静止、弱めて視認性確認 |
| FXAA | 葉・細線・文字のジャギーとぼけ、ソース更新後も眼境界clampが有効 |
| fog | 近景を保ち遠景を空色へ、岩へ雲が透けない、空に再適用しない、半透明の限界 |
| shaft | 葉の隙間に対応、白い床が発光源にならない、背面でpass停止、画面端の引き伸ばしなし |
| temporal | 静止時の葉のちらつきと、移動時の残像を両方確認。resize・FOV・テレポート・長い停止後の履歴を捨てる |

## 負荷の捉え方

仕上げONはbloom 3＋統合1＋FXAA 1、shaft有効なら追加5、さらにホストの最終出力がある。メイン3Dシーンの追加描画が0でもGPU負荷は増える。縦横1/4なら画素数は約1/16。64 tap積分、全解像度の複数サンプル、履歴の帯域とXR解像度に注意する。

同梱 `inspection.mainDraws` は描画時点のレンダラー統計のスナップショットで、GPU時間の測定器ではない。`bloomPasses` も静的な値なのでOFF時の実パス数と同一視しない。負荷比較は同じcamera・解像度で行い、不要効果のskipや解像度変更の効果を測る。

## 実際の失敗から得た注意点

| 症状 | 原因 | 修正・再発確認 |
|---|---|---|
| bloom幅を増やすと像が多重化 | 少数tapの間隔だけ拡大 | 連続したガウス核、隣接tapのペアリング。核の正規化と単調減少をテスト |
| 強いgrainに斜めの規則模様 | ノイズの空間的相関 | 整数ハッシュへ変更。高強度で確認後に本来の強度へ戻す |
| 葉が動くとシャフトが急に現れる | 低解像度の二値遮蔽マスク | 元深度4×4平均＋積分前のマスクぼかし |
| 空間ぼかし後も明るさがちらつく | 遮蔽変化の時間的変動 | シャフトの輝度だけ指数補間。歩行残像を回転再投影＋並進時の履歴減衰で抑制 |
| 岩に雲が透けて見える | フォグ色へ雲あり空画像を合成 | 雲なしairlightを別に生成 |
| プレビュー調整が公開版へ入る | WorldがUIをimport | devエントリーからのみ接続し、本番到達チャンクと公開対象を検査 |

## 実装例の由来

HELIOSというXRiftワールドの制作を通じて、HDRの画面仕上げと、共有深度によるフォグ・ライトシャフトを実装した。ブルームの多重像、グレインの規則模様、葉の揺れによるちらつき、岩に雲が重なる現象を修正し、上の表に整理した。

同梱コードは [Finish.tsx](../assets/sample/components/Finish.tsx)、[Atmosphere.tsx](../assets/sample/components/Atmosphere.tsx)、[bloom.ts](../assets/sample/lighting/bloom.ts)、[aerialPerspective.ts](../assets/sample/lighting/aerialPerspective.ts)、[shaftTemporal.ts](../assets/sample/lighting/shaftTemporal.ts) にまとまっている。値は [finishSettings.ts](../assets/sample/finishSettings.ts) が基準。

元ワールドからの抽出時に、太陽の定数だけを独立させ、ブルームの縮小ターゲット幅も偶数へ丸めた。検査スクリプトは別のプロジェクトの依存関係を使える形に整理している。元ワールドのPCブラウザでの描画確認と、同梱サンプルの型・数値検査を区別し、実機VRは未検証として扱う。
