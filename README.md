# XRift Postprocessing

XRiftのワールド制作で使える、ポストプロセスの実装・調整用エージェントスキルです。

ブルーム、色収差、カラー補正、ビネット、フィルムグレイン、FXAA、遠景フォグ、ライトシャフトを扱います。React Three Fiber / Three.jsのサンプルコードと、制作中に起きた多重像・ちらつきなどへの対処を収録しています。

## インストール

[skills CLI](https://github.com/vercel-labs/skills) からインストールできます。

```bash
npx skills add orange3134/xrift-postprocessing
```

すべてのプロジェクトで使う場合:

```bash
npx skills add orange3134/xrift-postprocessing -g
```

エージェント向けの詳しい説明は [SKILL.md](skills/xrift-postprocessing/SKILL.md) を参照してください。
