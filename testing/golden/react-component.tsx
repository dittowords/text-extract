// @ts-nocheck — a fixture, not compiled code. The unresolvable imports are
// deliberate: golden.test.ts asserts import specifiers get rejected.
import { useState } from "react";

import { Icon } from "./Icon";

const ROUTE = "/settings/billing";
const MAX_RETRIES = 3;

export function BillingPanel({ planName }: { planName: string }) {
  const [error, setError] = useState<string | null>(null);

  async function save() {
    try {
      await fetch(ROUTE);
    } catch (e) {
      setError("We couldn't save your changes. Try again.");
    }
  }

  return (
    <section className="billing-panel" data-testid="billing-panel">
      <h2>Billing</h2>
      <p>Your plan renews on the first of each month.</p>
      <Icon name="credit-card" />
      <input
        placeholder="Card number"
        aria-label="Card number"
        type="text"
        id="card-number"
      />
      <button onClick={save} title="Save billing details">
        Save changes
      </button>
      {error && <span role="alert">{error}</span>}
    </section>
  );
}
