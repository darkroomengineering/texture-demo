import { Link } from "react-router";
import { Wrapper } from "~/components/wrapper";

export function meta() {
  return [{ title: "404 — Satus" }];
}

export default function NotFound() {
  return (
    <Wrapper lenis={false} className="items-center justify-center font-mono">
      <h1 className="text-[4rem]">404</h1>
      <p>Page Not Found</p>
      <Link to="/" className="underline">
        Go Home
      </Link>
    </Wrapper>
  );
}
