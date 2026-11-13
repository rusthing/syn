import { Badge } from "@/components/ui/Badge";
import { verdictMeta, STAGE_LABELS } from "@/lib/spec/defaults";
import type { Verdict } from "@/lib/api/types";

export function VerdictBadge({ verdict, dot }: { verdict: Verdict; dot?: boolean }) {
  const meta = verdictMeta(verdict);
  return (
    <Badge tone={meta.tone} dot={dot} mono>
      {meta.label}
    </Badge>
  );
}

export function StageBadge({ stage }: { stage: string }) {
  return (
    <span className="inline-flex items-center rounded border border-line bg-sunken px-1.5 text-[10.5px] font-medium text-muted">
      {STAGE_LABELS[stage] ?? stage}
    </span>
  );
}
