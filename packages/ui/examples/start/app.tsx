/** @jsxImportSource @virentia/ui */
import { store } from "@virentia/ui";
import "./style.css";

interface PageData {
  path: string;
  greeting: string;
}

export default function App({ data }: { data: PageData }) {
  const count = store(0);

  return (
    <main>
      <p class="eyebrow">VIRENTIA / START</p>
      <h1>{data.greeting}</h1>
      <p>
        This page was rendered for <code>{data.path}</code> and hydrated in place.
      </p>
      <button onClick={() => count.value++}>Clicked {count.value} times</button>
    </main>
  );
}
