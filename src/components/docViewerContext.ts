import { createContext, useContext } from 'react'

/**
 * The context that lets any record number open as a dialog without leaving the page
 * you are on. DocViewer.tsx provides it; DocLink consumes it. It lives in its own
 * file so the two components never import each other.
 */
export const DocViewerContext = createContext<{ openDoc: (id: string) => void }>({
  openDoc: () => {},
})

export const useDocViewer = () => useContext(DocViewerContext)
