// v1.2 merge context: present only while flag.sales_admin_merge_v12 is ON (null = v1.1 page exactly).
import { createContext, useContext } from 'react';
import type { LiveMember, LiveTeam, MergeState } from './api';

export type MergeCtx = {
  m: MergeState;
  liveTeam: (consoleTeamId: string) => LiveTeam | null;
  rename: (teamId: number, name: string) => Promise<void>;
  toggle: (teamId: number, enabled: boolean) => Promise<void>;
  busy: number | null;
};
export const MergeContext = createContext<MergeCtx | null>(null);
export const useMerge = () => useContext(MergeContext);

const FA = (n: number) => String(n).replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[Number(d)]!);
/** Same wording as «تیم‌های فروش»: «بدون اولویت» / «اولویت ۱» (نوبتی when two members share it) / «اولویت ۲» / «اولویت ۳». */
export function priorityChips(m: LiveMember, team: LiveTeam): string[] {
  const p1Rot = team.members.filter((x) => x.ownsP1).length === 2;
  const out: string[] = [];
  if (m.ownsNone) out.push('بدون اولویت');
  if (m.ownsP1) out.push(p1Rot ? `اولویت ${FA(1)}، نوبتی` : `اولویت ${FA(1)}`);
  if (m.ownsP2) out.push(`اولویت ${FA(2)}`);
  if (m.ownsP3) out.push(`اولویت ${FA(3)}`);
  return out;
}
