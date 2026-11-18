/**
 * 统一测试入口：把各测试文件注册到同一个 runner 进程。
 * 运行：node test/run-all.mjs
 * 单独跑某一组：node test/rewrite.test.mjs / node test/install.test.mjs
 */
await import('./rewrite.test.mjs')
await import('./install.test.mjs')
