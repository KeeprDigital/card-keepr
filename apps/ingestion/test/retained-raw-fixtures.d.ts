declare module "*.body?raw" {
  const body: string;
  export default body;
}

declare module "*.body?url&inline" {
  const dataUrl: string;
  export default dataUrl;
}
