// Font display: Anton (heading/angka tebal) + Poppins (body).
// Antigravity boleh ganti/menambah weight sesuai kebutuhan.
import { loadFont as loadAnton } from "@remotion/google-fonts/Anton";
import { loadFont as loadPoppins } from "@remotion/google-fonts/Poppins";

export const anton = loadAnton().fontFamily;
export const poppins = loadPoppins("normal", { weights: ["400", "600", "800"] }).fontFamily;
