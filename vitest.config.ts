/**
 * vitest 配置：CSS / 静态资源在测试里 no-op（组件 spec 只断言行为，
 * 视觉由官方 styling 门禁覆盖）；CSS Modules 映射为空对象即可。
 */
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    // CSS 与静态资源在测试里 no-op：组件 spec 只断言行为，不关心样式。
    server: {
      deps: {
        inline: ['@deepseek-ai/dsh-client-ui-primitives'],
      },
    },
  },
  plugins: [{
    name: 'dsh-qol-test-css-stub',
    enforce: 'pre',
    resolveId(source) {
      if (source.endsWith('.css') || source.endsWith('.module.css')) return `\0stub:${source}`
      return null
    },
    load(id) {
      if (id.startsWith('\0stub:')) return 'export default {}'
      return null
    },
  }],
})
