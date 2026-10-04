package com.faceclaw.app

import kotlin.test.*

class TextureCacheTest {
    private fun u32(bytes: ByteArray, offset: Int): Int =
        (0..3).fold(0) { n, i -> n or ((bytes[offset + i].toInt() and 255) shl (i * 8)) }

    @Test
    fun offsetsAbove64KiBAndLazyFontSlotsRoundTripOnBothPlatforms() {
        val cache = TextureCacheState()
        val large = ImageAtlas.Entry(255, 255, ByteArray(255 * 255) { (it % 15 + 1).toByte() })
        repeat(3) { assertTrue(cache.ensureImage(it, large) >= 0) }
        val glyph = GlyphAtlas.Glyph(1, 1, 0, 1, 0, null, byteArrayOf(15))
        val offset = cache.ensureGlyph(42, 65, glyph)
        val table = cache.fontTableOffset(42)
        assertTrue(table > 65535)
        assertEquals(table + 384, offset)
        val memory = ByteArray(TextureCacheState.CACHE_SIZE)
        for (upload in cache.drainUploadPayloads(3600)) {
            assertEquals(18, upload[0].toInt())
            var pos = 1
            while (pos < upload.size) {
                val address = u32(upload, pos)
                val length = (upload[pos + 4].toInt() and 255) or ((upload[pos + 5].toInt() and 255) shl 8)
                upload.copyInto(memory, address, pos + 6, pos + 6 + length)
                pos += 6 + length
            }
            assertEquals(upload.size, pos)
        }
        assertEquals(offset, u32(memory, table + (65 - 32) * 4))
        assertContentEquals(glyph.cachedBytes, memory.copyOfRange(offset, offset + glyph.cachedBytes.size))
        assertEquals(offset, cache.ensureGlyph(42, 65, glyph))
        assertFalse(cache.hasPendingUploads())
        cache.reset()
        assertEquals(0, cache.usedBytes())
        assertEquals(384, cache.ensureGlyph(42, 65, glyph))
        assertTrue(cache.hasPendingUploads())
    }

    @Test
    fun plannerReusesResidencyAndReuploadsAfterReset() {
        val cache = TextureCacheState()
        val id = ImageAtlas.ensure("texture-test-white", 2, 2, ArrayByteReader(ByteArray(4) { -1 }))
        val pixels = ByteArray(8 * 4)
        for (y in 0..1) for (x in 0..1) pixels[y * 8 + x] = -1
        val packed = BmpUtil.pack4bppFromGray8(pixels, 8, 4)
        val draws = arrayOf(SurfaceCompositor.ScreenDraw.image(id, 0, 0))
        fun plan() = assertNotNull(TexturePlanner.plan(null, packed, 8, 4, draws, cache, 1, true, 8, testPlatform()))
        val cold = plan()
        assertEquals(1, cold.drawnImages)
        assertTrue(cold.uploads.isNotEmpty())
        val warm = plan()
        assertTrue(warm.uploads.isEmpty())
        assertContentEquals(cold.payload, warm.payload)
        cache.reset()
        assertTrue(plan().uploads.isNotEmpty())
        // Occlusion fails the correctness check and leaves the image baked.
        assertNull(TexturePlanner.plan(null, ByteArray(packed.size), 8, 4, draws, cache, 1, true, 8, testPlatform()))
    }

    @Test
    fun dimmedAntiAliasedTextStaysCachedGlyphs() {
        // A 4x2 AA glyph whose edges carry the coverage levels (2, 3) that a quarter dim used to
        // round up to level 1 where the firmware LUT draws 0.
        val coverage = arrayOf(intArrayOf(15, 8, 3, 2), intArrayOf(2, 3, 8, 15))
        val key = "dim-reshade-test".encodeToByteArray()
        GlyphAtlas.registerAa(ArrayByteReader(byteArrayOf(key.size.toByte()) + key + byteArrayOf(
            4, 1, 0, 65, 0, 0, 0, 0, 1, 4, 2, 0xf8.toByte(), 0x32, 0x23, 0x8f.toByte())))
        val fontId = GlyphAtlas.fontId("dim-reshade-test")
        val value = 235
        fun composite(paintOver: Boolean): SurfaceCompositor.Composite {
            val c = SurfaceCompositor()
            c.configureScreen(8, 4)
            c.configureSurface("term", 0, 0, 8, 4, 0, 0)
            // Baked as the TS side does: level n * top / 15, written as 16 * level.
            val pixels = ByteArray(32)
            for (row in 0..1) for (col in 0..3) pixels[(1 + row) * 8 + 1 + col] = (coverage[row][col] * 16).toByte()
            if (paintOver) pixels[1 * 8 + 1] = 100
            val draw = byteArrayOf(0, fontId.toByte(), (fontId shr 8).toByte(), 65, 0, 0, 0, 1, 0, 0, 0, value.toByte())
            c.submitSurface("term", ArrayByteReader(pixels), 0, 0, 8, 4, "1", ArrayByteReader(draw))
            c.setUnderlayDim(1, 64)
            return c.composite()
        }
        fun plan(composite: SurfaceCompositor.Composite) = TexturePlanner.plan(null,
            BmpUtil.pack4bppFromGray8(composite.gray, 8, 4), 8, 4, composite.draws, TextureCacheState(), 1, true, 8,
            testPlatform())

        val dimmed = composite(paintOver = false)
        // dimValue(235, 64) = 59 is level 4: the LUT gives n * 4 / 15, and 1 (black) for level 0.
        assertEquals(64, dimmed.gray[1 * 8 + 1].toInt() and 255)
        assertEquals(32, dimmed.gray[1 * 8 + 2].toInt() and 255)
        assertEquals(1, dimmed.gray[1 * 8 + 3].toInt() and 255)
        assertEquals(1, dimmed.gray[1 * 8 + 4].toInt() and 255)
        val result = assertNotNull(plan(dimmed))
        assertEquals(1, result.drawnGlyphs)
        assertEquals(0, result.bakedCandidates)

        // Ink the surface painted over is not the glyph's: it dims as raster and stays baked.
        val covered = composite(paintOver = true)
        assertEquals(25, covered.gray[1 * 8 + 1].toInt() and 255)
        assertEquals(0, plan(covered)?.drawnGlyphs ?: 0)
    }

    @Test
    fun fullCacheResetsAndRetriesTheCurrentFrame() {
        val cache = TextureCacheState()
        val large = ImageAtlas.Entry(255, 255, ByteArray(255 * 255) { (it % 15 + 1).toByte() })
        var fillerId = -1
        while (cache.ensureImage(fillerId--, large) >= 0) {}
        // Fill the remaining tail, forcing the next real allocation to fail.
        val remaining = TextureCacheState.CACHE_SIZE - cache.usedBytes()
        while (cache.ensureImage(fillerId--, ImageAtlas.Entry(1, 1, byteArrayOf(15))) >= 0) {}
        assertTrue(remaining > 0)
        val generation = cache.generation()
        val id = ImageAtlas.ensure("texture-test-full", 2, 2, ArrayByteReader(ByteArray(4) { -1 }))
        val result = assertNotNull(TexturePlanner.plan(null, ByteArray(4) { -1 }, 4, 2,
            arrayOf(SurfaceCompositor.ScreenDraw.image(id, 0, 0)), cache, 1, true, 8, testPlatform()))
        assertEquals(generation + 1, cache.generation())
        assertEquals(1, result.drawnImages)
        assertTrue(cache.usedBytes() < 100)
        assertTrue(result.uploads.isNotEmpty())
    }

    @Test
    fun workingSetLargerThanTheCacheFallsBackWithoutAResetLoop() {
        val cache = TextureCacheState()
        val raster = ByteArray(255 * 255) { if (it % 2 == 0) 16 else 32 }
        val draws = (0..4).map {
            val id = ImageAtlas.ensure("oversized-working-set-$it", 255, 255, ArrayByteReader(raster))
            SurfaceCompositor.ScreenDraw.image(id, 0, 0)
        }.toTypedArray()
        val gray = ByteArray(256 * 256)
        repeat(255) { raster.copyInto(gray, it * 256, it * 255, (it + 1) * 255) }
        val result = assertNotNull(TexturePlanner.plan(null,
            BmpUtil.pack4bppFromGray8(gray, 256, 256), 256, 256, draws, cache, 1, true, 8, testPlatform()))
        assertEquals(1, cache.generation())
        assertEquals(4, result.drawnImages)
        assertEquals(1, result.bakedCandidates)
        assertTrue(cache.usedBytes() <= TextureCacheState.CACHE_SIZE)
    }
}
