import sys
import json

def obtener_respuesta_base(titulo, tipo="pelicula", temporada=None, episodio=None):
    """
    Retorna una respuesta informativa en formato JSON indicando
    que se están utilizando reproductores multiservidor directos.
    """
    if tipo == "serie" and temporada and episodio:
        mensaje = f"Utilizando reproductores multiservidor directos para la serie '{titulo}' (T{temporada}:E{episodio})."
    elif tipo == "serie":
        mensaje = f"Utilizando reproductores multiservidor directos para la serie '{titulo}'."
    else:
        mensaje = f"Utilizando reproductores multiservidor directos para la película '{titulo}'."

    return {
        "status": "info",
        "tipo": tipo,
        "titulo": titulo,
        "temporada": temporada,
        "episodio": episodio,
        "message": mensaje
    }

if __name__ == "__main__":
    # Ejemplo de uso desde consola:
    # python extractor.py "Matrix"
    # python extractor.py "Breaking Bad" serie 1 5
    if len(sys.argv) > 1:
        titulo = sys.argv[1]
        tipo = sys.argv[2] if len(sys.argv) > 2 else "pelicula"
        temporada = sys.argv[3] if len(sys.argv) > 3 else None
        episodio = sys.argv[4] if len(sys.argv) > 4 else None

        print(json.dumps(obtener_respuesta_base(titulo, tipo, temporada, episodio), ensure_ascii=False))
    else:
        print(json.dumps({"status": "error", "message": "Falta el título"}))