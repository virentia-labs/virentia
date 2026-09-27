/** @jsxImportSource @virentia/ui */
import { store, useId } from "@virentia/ui";

export interface AppProps {
  initialCount?: number;
}

function ProfileField(props: { label: string; initialText: string }) {
  const id = useId();
  // Both instances have the same compiler SID, namespaced by their tree position.
  const text = store(props.initialText);

  return (
    <div class="field">
      <label htmlFor={id}>{props.label}</label>
      <input
        id={id}
        value={text.value}
        onInput={(event) => {
          text.value = event.currentTarget.value;
        }}
      />
      <p>
        Hello, <strong>{text.value || "stranger"}</strong>.
      </p>
    </div>
  );
}

export function App(props: AppProps) {
  // Server props start at 7; the browser's initial value is 0. Its snapshot wins.
  const count = store(props.initialCount ?? 0);

  return (
    <main>
      <header>
        <p class="eyebrow">VIRENTIA / UI · SSR + HYDRATION</p>
        <h1>
          Sent as HTML.
          <br />
          Kept as DOM.
        </h1>
        <p class="intro">
          This view arrived fully rendered. Hydration attaches reactive bindings to the same nodes.
        </p>
      </header>

      <section aria-labelledby="counter-heading">
        <div class="section-heading">
          <h2 id="counter-heading">A request-scoped counter</h2>
          <span class="badge">Server state → client scope</span>
        </div>
        <div class="counter">
          <button
            type="button"
            aria-label="Decrease"
            onClick={() => {
              count.value--;
            }}
          >
            −
          </button>
          <output data-count>{count.value}</output>
          <button
            type="button"
            aria-label="Increase"
            onClick={() => {
              count.value++;
            }}
          >
            +
          </button>
        </div>
        <p>The browser initializer is 0. The default server snapshot starts at 7.</p>
      </section>

      <section aria-labelledby="fields-heading">
        <div class="section-heading">
          <h2 id="fields-heading">Two instances, independent state</h2>
          <span class="badge">Stable IDs</span>
        </div>
        <div class="fields">
          <ProfileField label="First name" initialText="Ada" />
          <ProfileField label="Second name" initialText="Linus" />
        </div>
        <p>
          Each label uses <code>useId()</code>. Editing an input updates its text in place.
        </p>
        <label htmlFor="ssr-notes">Uncontrolled notes (HTML text round-trip)</label>
        <textarea id="ssr-notes" defaultValue={"\nNotes <&\rsecond line"} />
      </section>
    </main>
  );
}
