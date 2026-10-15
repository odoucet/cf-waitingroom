// SPDX-License-Identifier: Apache-2.0
// Text modules (wrangler imports .html and .txt files as strings by default).
declare module "*.html" {
  const content: string;
  export default content;
}
declare module "*.txt" {
  const content: string;
  export default content;
}
