/** Home card sizes: grid columns of the six-column Home grid at desktop width, and the body area a card designs for. */
export const CARD_SIZES = {
  S: { label: "S", columns: 2, span: "lg:col-span-2", width: 340 },
  M: { label: "M", columns: 3, span: "lg:col-span-3", width: 520 },
  L: { label: "L", columns: 4, span: "lg:col-span-4", width: 700 },
  XL: { label: "XL", columns: 6, span: "lg:col-span-6", width: 1080 },
} as const;
export type CardSize = keyof typeof CARD_SIZES;
export const CARD_SIZE_KEYS = Object.keys(CARD_SIZES) as CardSize[];
/** Every card has the same fixed height, so Home rows line up and nothing scrolls. */
export const CARD_HEIGHT = 300;
/** Height left for the card's own content under the title row. */
export const CARD_BODY_HEIGHT = 236;
export const isCardSize = (value: unknown): value is CardSize => typeof value === "string" && Object.hasOwn(CARD_SIZES, value);
export const cardSize = (value: string): CardSize => isCardSize(value) ? value : "M";
