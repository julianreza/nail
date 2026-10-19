import LoginForm from "./login-form";

export default function LoginPage() {
  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <section className="flex w-full max-w-lg flex-col gap-6 rounded-2xl border border-zinc-300 bg-white p-8 shadow-lg">
        <div>
          <p className="text-sm font-semibold uppercase tracking-wide text-zinc-600">
            Nail · Area owner
          </p>
          <h1 className="mt-2 text-3xl font-semibold">Masuk</h1>
          <p className="mt-2 text-zinc-600">
            Akses hanya untuk owner. Pendaftaran publik tidak tersedia.
          </p>
        </div>
        <LoginForm />
      </section>
    </main>
  );
}
