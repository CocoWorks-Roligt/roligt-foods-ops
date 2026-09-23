import { useEffect } from 'react'
import { useKindeAuth } from '@kinde-oss/kinde-auth-react'
import { bindKinde } from '../lib/kindeSession'

/**
 * The installed Kinde SDK (5.13.1) exposes no client usable outside React — every
 * method hangs off `useKindeAuth()` under <KindeProvider>. This hidden component
 * grabs that context once and hands it to lib/kindeSession.ts, so AuthContext can
 * read the session without being Kinde-coupled itself. It mounts only when Kinde
 * envs are configured; the dev fallback never renders it, nor the provider.
 */
export function KindeBridge() {
  const kinde = useKindeAuth()
  useEffect(() => {
    bindKinde(kinde)
  }, [kinde])
  return null
}
