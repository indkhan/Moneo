export type PreviewTheme = "light" | "dark";

export const draftPagePath = (artifactId: string, token: string, theme: PreviewTheme) => `/ai/artifacts/${artifactId}/draft?d=${token}&theme=${theme}`;
export const draftCardPath = (artifactId: string, token: string, size: string, theme: PreviewTheme) => `/ai/artifacts/${artifactId}/draft-card?d=${token}&size=${size}&theme=${theme}`;

export const isDraftCardPreview = (pathname: string) => /^\/ai\/artifacts\/[^/]+\/draft-card$/.test(pathname);
