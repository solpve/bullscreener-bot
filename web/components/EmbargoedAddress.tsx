import { ADDRESS_EMBARGO_LABEL } from '@/lib/flags';
import { SOLSCAN } from '@/lib/links';

/**
 * The BULL deposit address is a one-way door: once published it is irreversibly
 * baked into every participating coin's config. Callers pass `null` whenever
 * NEXT_PUBLIC_SHOW_ADDRESS !== "true" so the value never reaches the rendered
 * HTML at all — this component only decides how the absence looks.
 */
export default function EmbargoedAddress({
  address,
  label,
}: {
  address: string | null;
  label?: string;
}) {
  if (address === null) {
    return (
      <span
        className="chip chip--unverified chip--phrase"
        title="Withheld until launch"
      >
        {ADDRESS_EMBARGO_LABEL}
      </span>
    );
  }

  return (
    <a
      className="addr link"
      href={SOLSCAN.account(address)}
      target="_blank"
      rel="noreferrer noopener"
      aria-label={label ?? `View ${address} on Solscan`}
    >
      {address}
    </a>
  );
}
