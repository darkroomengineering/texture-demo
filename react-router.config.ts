import { vercelPreset } from "@vercel/react-router/vite";
import type { Config } from "@react-router/dev/config";

export default {
  ssr: true,
  presets: [vercelPreset()],
  future: {
    v8_middleware: true,
  },

  appDirectory: "app",
} satisfies Config;
