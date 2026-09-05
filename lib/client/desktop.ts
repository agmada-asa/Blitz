/** Types the isolated Electron bridge used by project file actions. */

export {}

declare global {
  interface Window {
    /** Present only inside the sandboxed local Electron renderer. */
    blitzDesktop?: {
      getServiceStatus: () => Promise<Record<string, string>>
      openFile: (projectId: string, path: string) => Promise<string>
      revealFile: (projectId: string, path: string) => Promise<string>
    }
  }
}
