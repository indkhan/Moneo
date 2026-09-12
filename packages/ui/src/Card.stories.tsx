import type { Meta, StoryObj } from "@storybook/react-vite";
import { Card, CardDescription, CardTitle } from "./Card.js";

const meta: Meta<typeof Card> = {
  title: "Primitives/Card",
  component: Card,
};

export default meta;
type Story = StoryObj<typeof Card>;

export const Default: Story = {
  render: () => (
    <Card>
      <CardTitle>Card title</CardTitle>
      <CardDescription>Card description</CardDescription>
    </Card>
  ),
};
