import { Card, CardDescription, CardHeader, CardTitle } from '@fivvi/ui/components/card';
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('home');
  return { title: t('title') };
}

/**
 * The signed-in home: a placeholder until F002 adds workspaces (docs/design/information-architecture.md,
 * the `/login` → home flow). The route guard that keeps anonymous visitors out is the next F001 ticket.
 */
export default async function HomePage() {
  const t = await getTranslations('home');
  return (
    <main className="flex min-h-dvh items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>
            <h1>{t('title')}</h1>
          </CardTitle>
          <CardDescription>{t('description')}</CardDescription>
        </CardHeader>
      </Card>
    </main>
  );
}
