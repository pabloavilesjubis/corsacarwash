/**
 * CORSA — cliente de Supabase de la Cuponera Digital (0083).
 *
 * Otro cliente, con su propia llave de almacenamiento: la sesión del usuario
 * externo no se mezcla con la del personal de CORSA. Alguien de CORSA puede
 * tener abierto el sistema y la cuponera en el mismo navegador sin que una
 * sesión pise a la otra.
 */
import { createClient } from '@supabase/supabase-js'

export const supabaseCuponera = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY,
  {
    auth: {
      storageKey: 'corsa-cuponera-auth',
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
    },
  },
)
