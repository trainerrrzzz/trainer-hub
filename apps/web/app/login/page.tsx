import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { currentLocale } from '../../i18n/current-locale';
import { SignInForm } from './sign-in-form';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('signIn');
  return { title: t('title') };
}

/** TW-10 Sign in (`/login`): the email step, then the code step (F001). */
export default async function LoginPage() {
  return <SignInForm locale={await currentLocale()} />;
}
