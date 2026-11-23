import { signOut } from "@/server/auth/actions";

export function SignOutButton() {
  return (
    <form action={signOut}>
      <button
        type="submit"
        className="rounded-lg border border-line bg-white px-3 py-1.5 text-sm font-medium text-ink hover:border-accent"
      >
        Sign out
      </button>
    </form>
  );
}
