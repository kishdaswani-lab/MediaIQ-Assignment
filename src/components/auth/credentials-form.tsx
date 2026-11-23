"use client";

import { useActionState } from "react";
import {
  requestPasswordReset,
  signIn,
  signUp,
  updatePassword,
  type AuthFormState,
} from "@/server/auth/actions";
import {
  AuthMessage,
  authButtonClassName,
  authFieldClassName,
} from "@/components/auth/auth-screen";

const initialState: AuthFormState = {};

export function SignInForm({ next }: { next?: string }) {
  const [state, action, pending] = useActionState(signIn, initialState);

  return (
    <form action={action} className="space-y-4">
      {next ? <input type="hidden" name="next" value={next} /> : null}
      <CredentialFields />
      {state.error ? <AuthMessage tone="error">{state.error}</AuthMessage> : null}
      <button className={authButtonClassName} type="submit" disabled={pending}>
        {pending ? "Signing in" : "Sign in"}
      </button>
    </form>
  );
}

export function SignUpForm() {
  const [state, action, pending] = useActionState(signUp, initialState);

  return (
    <form action={action} className="space-y-4">
      <CredentialFields />
      {state.error ? <AuthMessage tone="error">{state.error}</AuthMessage> : null}
      {state.message ? <AuthMessage tone="info">{state.message}</AuthMessage> : null}
      <button className={authButtonClassName} type="submit" disabled={pending}>
        {pending ? "Creating account" : "Create account"}
      </button>
    </form>
  );
}

export function ForgotPasswordForm() {
  const [state, action, pending] = useActionState(requestPasswordReset, initialState);

  return (
    <form action={action} className="space-y-4">
      <label className="block text-sm font-medium" htmlFor="email">
        Email
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          className={authFieldClassName}
        />
      </label>
      {state.error ? <AuthMessage tone="error">{state.error}</AuthMessage> : null}
      {state.message ? <AuthMessage tone="info">{state.message}</AuthMessage> : null}
      <button className={authButtonClassName} type="submit" disabled={pending}>
        {pending ? "Sending" : "Send reset instructions"}
      </button>
    </form>
  );
}

export function ResetPasswordForm() {
  const [state, action, pending] = useActionState(updatePassword, initialState);

  return (
    <form action={action} className="space-y-4">
      <PasswordField id="password" label="New password" autoComplete="new-password" />
      <PasswordField
        id="confirmation"
        name="confirmation"
        label="Confirm password"
        autoComplete="new-password"
      />
      {state.error ? <AuthMessage tone="error">{state.error}</AuthMessage> : null}
      <button className={authButtonClassName} type="submit" disabled={pending}>
        {pending ? "Updating" : "Update password"}
      </button>
    </form>
  );
}

function CredentialFields() {
  return (
    <>
      <label className="block text-sm font-medium" htmlFor="email">
        Email
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          className={authFieldClassName}
        />
      </label>
      <PasswordField id="password" label="Password" autoComplete="current-password" />
    </>
  );
}

function PasswordField({
  id,
  name = id,
  label,
  autoComplete,
}: {
  id: string;
  name?: string;
  label: string;
  autoComplete: string;
}) {
  return (
    <label className="block text-sm font-medium" htmlFor={id}>
      {label}
      <input
        id={id}
        name={name}
        type="password"
        autoComplete={autoComplete}
        required
        className={authFieldClassName}
      />
    </label>
  );
}
