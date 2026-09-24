import aiohttp
import asyncio

TMDB_API_KEY = "76fac3ba42f8bf2c76af4114610465da"

async def probar_tmdb():
    if TMDB_API_KEY == "TU_API_KEY_AQUI":
        print("[!] Recuerda configurar tu TMDB_API_KEY para hacer la prueba.")
        return

    url = f"https://api.themoviedb.org/3/movie/popular?api_key={TMDB_API_KEY}&language=es-ES"
    async with aiohttp.ClientSession() as session:
        async with session.get(url) as resp:
            if resp.status == 200:
                data = await resp.json()
                print(f"[+] Conexión exitosa a TMDB. Películas obtenidas: {len(data.get('results', []))}")
            else:
                print(f"[!] Error al conectar con TMDB. Status: {resp.status}")

if __name__ == "__main__":
    asyncio.run(probar_tmdb())