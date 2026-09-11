export default {
  printWidth: 120,
  tabWidth: 2,
  useTabs: false,
  singleQuote: false,
  trailingComma: "all",
  semi: true,
  proseWrap: "preserve",
  overrides: [{ files: "**/tsconfig*.json", options: { parser: "jsonc" } }],
};
