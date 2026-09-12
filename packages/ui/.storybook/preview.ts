import type { Preview } from "@storybook/react-vite";

const preview: Preview = {
  parameters: {
    actions: { argTypesRegex: "^on.*" },
  },
};

export default preview;
