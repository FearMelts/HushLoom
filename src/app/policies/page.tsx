import Link from "next/link";
import { pricing } from "@/config/pricing";

export const metadata = { title: "Policies" };

const sections: { id: string; title: string; body: React.ReactNode }[] = [
  {
    id: "adults",
    title: "Adults only",
    body: (
      <>
        <p>Hushloom is for people who are 18 or older and of legal age where they live. Signing up asks for a date of birth and a confirmation, and both are recorded.</p>
        <p>
          Some regions require stronger age assurance than a self-declaration: the UK and a number of US states. If you are in one of them, creating, uploading and previews wait until you pass an age
          check with our verification provider, from Settings. We keep only the outcome, the provider&apos;s reference and the dates, never your ID images or biometrics, and a check lasts a year by default before it must be redone.
        </p>
      </>
    ),
  },
  {
    id: "content",
    title: "What can never be made here",
    body: (
      <>
        <ul>
          <li>Anyone under 18, or anyone who looks or is described as a minor, in any sexual or suggestive context.</li>
          <li>Non-consensual scenarios, including coercion, intoxication, sleep or hidden cameras.</li>
          <li>Real, identifiable people without their consent, including public figures.</li>
          <li>Sexual content involving animals or family members.</li>
          <li>Extreme violence or harm presented sexually.</li>
        </ul>
        <p>Prompts are checked on the server before any credits are held, and blocked attempts are logged for review. Templates and creations can be reported from their page.</p>
      </>
    ),
  },
  {
    id: "consent",
    title: "Uploads and likeness",
    body: (
      <>
        <p>
          Before you upload a photo or video, you confirm that everyone in it is an adult and agreed to its use. A character reference in Train needs a separate likeness consent. Each confirmation is stored
          as a consent record you can see in Settings.
        </p>
        <p>Withdrawing a consent deletes the upload or reference and every creation made from it. Creations that used an upload or a character can never be published as templates.</p>
      </>
    ),
  },
  {
    id: "abuse",
    title: "Abuse scanning and takedowns",
    body: (
      <>
        <p>
          Every upload and every creation is checked against known child sexual abuse material before it can be shown, used or published. A match is blocked, kept as evidence for the
          authorities, and the account is suspended while a person reviews it. If the check cannot run, nothing unchecked is kept: an upload asks you to try again in a few minutes, and a
          creation waits and retries, or fails with your credits returned.
        </p>
        <p>
          To report content that shows you without your consent, uses your likeness, or involves anyone under 18,{" "}
          <Link href="/policies/takedown" className="text-ember-400 underline-offset-2 hover:underline">
            request a takedown
          </Link>
          . You do not need an account.
        </p>
      </>
    ),
  },
  {
    id: "privacy",
    title: "Privacy",
    body: (
      <>
        <p>
          Everything you make is private unless you publish it. Private media is served only through short-lived signed links tied to your session, and the app asks search engines not to index any page.
        </p>
        <p>
          Discovery uses the categories and tags of templates you saved, made or viewed, and the interests you pick. You can turn personalization or history off, and clear history at any time. Deleting your
          account or a creation hides it at once, and its files are removed from storage within 30 days. Withdrawing a consent removes the files right away.
        </p>
      </>
    ),
  },
  {
    id: "credits",
    title: "Credits",
    body: (
      <>
        <p>
          A still costs {pricing.imageBase} credits and a clip {pricing.videoPerSecond} per second, doubled for 4K. You always see the cost and confirm before credits are held. If a creation fails or you cancel
          it, the held credits come back in full. Retrying is a new creation and is charged again only when you confirm it.
        </p>
      </>
    ),
  },
  {
    id: "demo",
    title: "Demo models",
    body: (
      <p>
        Models marked Demo produce labeled placeholder images and clips so the app can be used without an AI provider. Their output is watermarked “DEMO OUTPUT · NOT AI-GENERATED” and is never presented as
        real generation.
      </p>
    ),
  },
];

export default function PoliciesPage() {
  return (
    <article className="mx-auto max-w-2xl">
      <p className="tag text-ember-400">Plain language</p>
      <h1 className="font-display text-4xl">Policies</h1>
      <p className="mt-2 text-sm text-bone-400">
        These describe how this build behaves. They are a product draft for the operator to review with counsel before launch, not legal terms.
      </p>
      <nav aria-label="On this page" className="mt-6 flex flex-wrap gap-2">
        {sections.map((s) => (
          <a key={s.id} href={`#${s.id}`} className="hairline rounded-full px-3 py-1 text-[13px] text-bone-300 hover:bg-ink-800">
            {s.title}
          </a>
        ))}
      </nav>
      <div className="mt-8 space-y-10">
        {sections.map((s) => (
          <section key={s.id} id={s.id} className="scroll-mt-24">
            <h2 className="mb-3 font-display text-2xl">{s.title}</h2>
            <div className="space-y-3 text-[15px] leading-relaxed text-bone-200 [&_li]:ml-5 [&_li]:list-disc [&_li]:pl-1 [&_ul]:space-y-1.5">{s.body}</div>
          </section>
        ))}
      </div>
    </article>
  );
}
