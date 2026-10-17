declare module "qrcode" {
  export function toDataURL(text: string, opts?: Record<string, unknown>): Promise<string>;
  const qrcode: { toDataURL: typeof toDataURL };
  export default qrcode;
}
