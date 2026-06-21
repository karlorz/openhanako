import { definePlugin } from "@hana/plugin-runtime";

export default definePlugin({
  async onload(ctx, { register }) {
    if (ctx.log?.info) {
      ctx.log.info(`office-workflow loaded (dataDir=${ctx.dataDir})`);
    }

    register && register({
      dispose() {
        if (ctx.log?.info) ctx.log.info("office-workflow unloaded");
      },
    });
  },

  async onunload(ctx) {
    if (ctx.log?.info) ctx.log.info("office-workflow unloaded");
  },
});
