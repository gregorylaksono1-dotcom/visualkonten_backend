import { Theme } from "./schema";

export const gradient = (t: Theme) =>
  `linear-gradient(160deg, ${t.bgFrom} 0%, ${t.bgTo} 100%)`;

// margin aman dari tepi (px, di canvas 1080x1920)
export const SAFE = 72;
