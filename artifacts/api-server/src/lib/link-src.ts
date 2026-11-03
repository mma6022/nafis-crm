/** links v1.0: src=links → «صفحه لینک‌ها» in the lead description; only while flag.links_page is ON (OFF: the raw src, as before). */
import { LINKS_SRC, LINKS_SRC_FA, linksOn } from "./link-page";
export const srcLineFa = (src: string) => (src === LINKS_SRC && linksOn() ? LINKS_SRC_FA : src);
