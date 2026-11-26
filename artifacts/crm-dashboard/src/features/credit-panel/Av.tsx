import "./credit-panel.css";
// Avatar letters: one element per letter in an RTL flex row, so the first name's letter is always on the right («یاسین غرقی» → «ی غ» read from the right).
const initials = (name: string) => name.replace(/^(آقای|خانم)\s+/, "").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]);
export const Av = ({ name }: { name: string }) => <span className="qcw-av" aria-hidden="true" dir="rtl" data-testid="qcw-av">{initials(name).map((l, i) => <i key={i}>{l}</i>)}</span>;
