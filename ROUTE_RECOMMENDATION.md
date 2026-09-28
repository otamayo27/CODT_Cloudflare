# Heurística de ruta recomendada

La recomendación se calcula en el navegador con las órdenes visibles de una dupla específica y la última carga disponible. No se recalcula con eventos operativos ocurridos después de esa carga.

## Prioridad de selección

1. ZCON cuya fecha `DEADLINE` está vencida o vence hoy.
2. ZREC vencidas, con vencimiento de hoy o sin fecha límite disponible. Solo se consideran las ZREC presentes en la carga.
3. ZCON futuras, ordenadas por la fecha límite más próxima. Cuando falta `DEADLINE`, se usa la antigüedad como criterio secundario.
4. ZREC con fecha límite futura, ordenadas por proximidad del vencimiento.
5. ZDES/ZDESC agrupadas geográficamente.
6. Otras órdenes cercanas.

Las ZCON y ZREC prioritarias no se excluyen para reducir distancia. La ruta conserva un máximo de 15 paradas.

## Desconexiones y retorno esperado

El 70 % no identifica órdenes individuales que serán reconectadas. Se aplica como costo esperado de retorno al comparar zonas ZDES/ZDESC: una zona resulta más conveniente cuando es compacta y permanece próxima al resto del recorrido prioritario. Las desconexiones seleccionadas se ubican después de las urgencias inmediatas y antes de las órdenes futuras, para favorecer su ejecución por la mañana.

## Capacidad y compactación

Al completar con ZDES/ZDESC u otras órdenes, la heurística deja de agregar paradas cuando simultáneamente:

- la siguiente orden incrementa el recorrido en más de 6 km en línea recta; y
- la secuencia proyectada supera 45 km en línea recta.

Por eso puede recomendar menos de 15 paradas. Estos umbrales son proxies de compactación, no una estimación de duración de jornada.

## Limitaciones

La línea del mapa conecta coordenadas con distancia geodésica. No representa carreteras ni una ruta vial óptima. Actualmente no se dispone de:

- duración estimada por tipo de trabajo;
- horario de inicio y fin de la dupla;
- punto de salida y retorno;
- tiempos por carretera, tráfico o restricciones viales;
- hora exacta de vencimiento de ZREC;
- reconexiones generadas después de la carga diaria.

Con esos datos podría evolucionarse a un problema de ruteo con ventanas de tiempo y capacidad real de jornada.
