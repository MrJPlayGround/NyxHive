import type { ChannelFactory } from "../types.js";

export const iosChannel: ChannelFactory = {
  name: "ios",
  async create(deps) {
    const { iOSChannel } = await import("../../channels/ios.js");
    return new iOSChannel({ config: deps.config, dataDir: deps.config.daemon.data_dir });
  },
};
