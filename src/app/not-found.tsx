import { ButtonLink } from "@/components/ui";

export default function NotFound() {
  return (
    <div className="mx-auto max-w-md py-20 text-center">
      <p className="tag text-ember-400">404</p>
      <h1 className="font-display text-4xl">A loose thread</h1>
      <p className="mt-2 text-sm text-bone-400">This page does not exist, or it is private to someone else.</p>
      <div className="mt-6 flex justify-center gap-2">
        <ButtonLink href="/" variant="ember">
          Back to Discover
        </ButtonLink>
        <ButtonLink href="/collection" variant="ghost">
          Your Library
        </ButtonLink>
      </div>
    </div>
  );
}
