import type { Metadata } from 'next'
import { Inter, JetBrains_Mono } from 'next/font/google'
import './globals.css'
import { Topbar } from '@/components/dashboard/topbar'
import { MetricsLiveProvider } from '@/lib/metrics-live'
import { DevOpsAssistant } from '@/components/dashboard/devops-assistant'
import { ThemeProvider } from '@/components/theme-provider'

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-sans',
})

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-mono',
})

export const metadata: Metadata = {
  title: 'NovaDeploy — AI DevOps Dashboard',
  description: 'AI-powered DevOps observability and incident management platform',
  generator: 'v0.app',
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en" className="bg-background" suppressHydrationWarning>
      <body className={`${inter.variable} ${jetbrainsMono.variable} font-sans antialiased`}>
        <ThemeProvider attribute="class" defaultTheme="dark" enableSystem={false} disableTransitionOnChange>
          <div className="min-h-screen bg-background grid-lines">
            <Topbar />
            <MetricsLiveProvider>
              {children}
              <DevOpsAssistant />
            </MetricsLiveProvider>
          </div>
        </ThemeProvider>
      </body>
    </html>
  )
}
