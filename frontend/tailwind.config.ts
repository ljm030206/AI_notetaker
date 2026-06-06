import type { Config } from "tailwindcss";
import typography from "@tailwindcss/typography";

const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      // 필요한 커스텀 테마가 있다면 여기에 추가
    },
  },
  plugins: [
    typography, // 👈 마크다운 렌더링을 위한 필수 플러그인
  ],
};
export default config;
