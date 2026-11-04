---
name: xrift-postprocessing
license: MIT
description: XRiftワールドのHDRポストプロセスをThree.js / React Three Fiberへ実装・調整する。ブルーム、色収差、カラー補正、トーンマッピング、ビネット、フィルムグレイン、FXAA、深度フォグ、ライトシャフトと時間補間のサンプル、XRの左右眼分離、ちらつき・多重像・雲の透けの修正を含む。水面シミュレーション、コースティクス生成、静的ライトベイク自体は対象外。
---

# XRift ポストプロセス

HELIOSで実装・修正した描画処理を別のXRiftワールドへ移植する。見た目の数値は作品固有のプリセットであり、全ワールドの必須値ではない。サンプルはThree.js 0.183.1のネイティブHDR出力経路を前提にする。別バージョンやホストへ移す際は実装と型を再確認する。

## 進め方

1. 対象の `package.json`、ロックファイル、`xrift.json`、開発エントリー、既存ポストプロセスを確認する。`node_modules/three/src/renderers/WebGLRenderer.js` と `webgl/WebGLOutput.js` で `setEffects`・HDRバッファ・swap契約を確認する。ホストとModule Federationで共有するThree.jsの互換性も確認する。
2. 初回導入・別ワールドへの移植では [統合とXR](references/integration.md) を読む。既存のエフェクト所有者と統合し、勝手にチェーンを置き換えない。
3. 必要な効果の資料だけを読む。
   - [ブルーム・色収差・カラー補正・ビネット・グレイン・FXAA](references/finish-effects.md)
   - [遠景フォグ・ライトシャフト・時間補間](references/atmosphere-effects.md)
4. [検証・実際に起きた問題](references/validation.md) に従い、効果単体のON/OFF、固定視点、移動中、本番チャンクを比較する。動く遮蔽物は静止画だけで判断しない。
5. 調整値をプリセットへ反映し、変更内容・実施した検証・未検証の端末を報告する。公開やアップロードは別途依頼された場合に行う。

## 再利用の基本

- メイン3Dシーンの描画とXRカメラ管理はホストに任せ、既に描画されたHDRの `read` を処理する。この構成で別のComposerや正の優先度の `useFrame` によるメイン再描画を追加しない。
- HDR中間画像は線形で保つ。トーンマッピングは一度だけ。サンプルは自前フィルミック曲線＋ `NoToneMapping`、表示色空間への変換はネイティブHDR出力に任せる。
- 左右眼それぞれの中心・行列と、入力テクスチャごとの半テクセル幅を使う。サンプルの左右横並び配置は他のXRレイアウトへそのまま適用しない。
- レンダラーの変更は `try/finally` で復元し、ホスト所有のターゲットや深度を破棄しない。履歴の初回・リサイズ・視点変更・無効化を扱う。
- 外部テクスチャを足す場合は `public/` に置き、`useXRift()` の `${baseUrl}path` で読み込む。`baseUrl` に `/` を追加しない。
- 調整UIは開発エントリーのみからimportする。本番Worldの依存ツリーから除外する。

## 同梱サンプル

[assets/sample](assets/sample) はワールド本体に依存しない7ファイルの実装例。`Finish.tsx` が各効果を統合し、`Atmosphere.tsx` がフォグとシャフト用の空を生成する。各効果の抜粋・値の意味・注意点は上記の資料にある。

任意のエフェクトだけ採用してよい。既存の空を置き換えずに使う場合は、空テクスチャ・太陽・行列の受け渡しをアダプター化する。ファイルを丸ごとコピーする前に [依存関係と移植手順](references/integration.md) を確認する。

[scripts/check-samples.mjs](scripts/check-samples.mjs) は、対象プロジェクトのThree.js・esbuildを使い、ブルーム核、深度所有権、距離復元、左右眼投影、時間補間を検証する。シェーダー描画や実機VRの検証は別に必要。

## 根拠と限界

HELIOSワールドの実装と制作時の改善を基に整理（2026-11-04）。[実装例の由来](references/validation.md#実装例の由来) を参照。初期試作値より、同梱 `finishSettings.ts` と現在の対象ワールドの要件を優先する。元ワールドのPCブラウザ検証は記録されているが、実機VRの画質・性能は未検証。CPUテスト成功だけでVR対応済みとしない。
