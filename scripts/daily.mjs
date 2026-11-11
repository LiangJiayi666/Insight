import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv, readJson } from '../src/runtime.mjs';
import { checkCredentials, Providers } from '../src/providers.mjs';
import { runDaily } from '../src/pipeline.mjs';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
try {
  await loadEnv(path.join(root, '.env'));
  checkCredentials();
  const settings = await readJson(path.join(root, 'config/settings.json'));
  const sources = await readJson(path.join(root, 'config/sources.json'));
  if (process.argv.includes('--check')) {
    console.log(`配置字段检查通过；目标 ${settings.targetStories} 条。未联网验证密钥、模型兼容性或来源可用性。`);
  } else {
    const args = process.argv.slice(2);
    if (args.length) throw new Error('daily 不支持回写旧日期，防止覆盖历史；直接运行 npm run daily。');
    const result = await runDaily({ root, settings, sources, providerFactory: (state, persist) => new Providers(settings, state, persist) });
    console.log(JSON.stringify(result, null, 2));
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
