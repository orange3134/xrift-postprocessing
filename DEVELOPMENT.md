# 検証と保守

Node.js 22.20以上を使用する。次のコマンドはリポジトリのルートで実行する。

```bash
npm ci
npm run typecheck
npm test
npx skills add . --list
```

`package.json` はサンプルを検証するための開発依存だけを定義する。スキルのインストールに `npm ci` は不要。

数値テストはブルーム核、深度の再利用と所有権、距離復元、左右眼の投影、フレームレート非依存の時間補間と履歴破棄を確認する。シェーダーの描画・実機VR・性能を証明するものではない。視覚的な確認項目は [検証ガイド](skills/xrift-postprocessing/references/validation.md) を参照。

スキルは `skills/xrift-postprocessing/` に配置する。配布物にはローカルの絶対パス、非公開チャットへの参照、認証情報、ワールドの未公開アセットを含めない。スキル内の `LICENSE` は、インストール後もサンプルの利用条件を確認できるよう同梱している。
