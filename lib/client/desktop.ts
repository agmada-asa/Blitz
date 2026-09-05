/** Types the isolated Electron bridge shared by file selection and project file actions. */
export type DesktopSelectedFile = {
  filename: string
  mimeType: string
  sizeBytes: number
  contents: Uint8Array
}

declare global {
  interface Window {
    /** Present only inside the sandboxed local Electron renderer. */
    blitzDesktop?: {
      selectFiles: (projectId: string) => Promise<DesktopSelectedFile[]>
      getServiceStatus: () => Promise<Record<string, string>>
      openFile: (projectId: string, path: string) => Promise<string>
      revealFile: (projectId: string, path: string) => Promise<string>
    }
  }
}
