import { FactorRemovalForm, FactorReplacementForm } from "@/components/auth/mfa-forms";

export function FactorManager({
  factors,
}: {
  factors: { id: string; friendlyName: string; status: string }[];
}) {
  const canRemove = factors.length > 1;

  return (
    <section className="rounded-2xl border border-line bg-white p-6">
      <h2 className="text-lg font-semibold">Authenticator</h2>
      <p className="mt-2 max-w-2xl text-sm leading-6 text-muted">
        Protected pages require this authenticator. Replacement needs a current code. Removing the
        only factor is refused.
      </p>
      <ul className="mt-4 space-y-2">
        {factors.map((factor) => (
          <li key={factor.id} className="rounded-xl border border-line px-3 py-2 text-sm">
            <span className="font-medium">{factor.friendlyName}</span>
            <span className="ml-2 text-muted">{factor.status}</span>
          </li>
        ))}
      </ul>
      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <FactorReplacementForm />
        {factors[0] ? (
          <FactorRemovalForm factorId={factors[0].id} canRemove={canRemove} />
        ) : null}
      </div>
    </section>
  );
}
