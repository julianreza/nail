# nail — Desain orchestrator agent pribadi

Status: draf desain untuk persetujuan pengguna; belum merupakan rencana implementasi atau izin membangun. Setelah disetujui, buat rencana implementasi terpisah dengan `superpowers:writing-plans`. Lokasi dokumen mengikuti permintaan pengguna untuk menyimpan dokumen perencanaan di `.hermes/plans/`.

## Goal

Membangun aplikasi web pribadi untuk memberi tugas kepada PM, yang mengoordinasikan agent engineer dan QA sampai menghasilkan perubahan kode serta bukti pengujian, dengan kontrol persetujuan dan koneksi beberapa provider.

## Keputusan pengguna dan konteks saat ini

- Digunakan sendiri, bukan SaaS multi-user.
- Referensi produk: Paperclip; yang diinginkan adalah pengelolaan tim agent, bukan sekadar pemilih model dalam chat.
- Contoh alur: pengguna → PM → FE/BE → QA → perbaikan atau hasil akhir. Peran dan hubungan kerja harus bisa diubah.
- Mendukung berbagai project; tidak dibatasi pada project frontend atau stack tertentu.
- Target koneksi: langganan ChatGPT, Claude, Gemini/Antigravity, serta API key DeepSeek dan provider lain.
- Keputusan deployment terakhir: aplikasi dan pekerjaan agent sama-sama berjalan di VPS Ubuntu dengan RAM 2 GB dan CPU 2 core. Opsi runner di laptop/server lain tidak dipilih.
- Arah visual disetujui berdasarkan `ChatGPT Image Oct 19, 2026, 02_14_59 PM.png`: putih tulang, lime, hijau gelap, sidebar pastel, outline tegas, kartu membulat, dan bayangan bergeser.
- Checkout `/home/ubuntu/Project/nail` masih starter Next.js 16.4.2, React 19.3.0, TypeScript strict, Tailwind CSS 4, Bun 1.4.3. Belum ada backend, database, runner, autentikasi, atau test suite.
- `AGENTS.md` sudah diperbarui dalam percakapan ini. Pertahankan perubahan tersebut, blok Next.js, dan aset pengguna yang belum tracked; jangan commit atau mengubah aset lain tanpa permintaan.
- Versi Ubuntu, arsitektur CPU, disk kosong, swap, domain, dan akses deploy belum diketahui. Jangan menyamakan mesin pengembangan ini dengan VPS target.

## Architecture / proposed approach

Pertahankan Next.js untuk UI dan API control plane, gunakan SQLite persisten untuk state dan antrean, serta satu proses worker terpisah yang menjalankan satu pekerjaan agent pada satu waktu. Worker menjalankan tool dan runtime agent dalam satu sandbox aktif di VPS yang sama; model AI tetap diakses melalui jaringan provider, bukan di-host di VPS. Browser hanya mengirim arahan dan mengikuti event tersimpan, sehingga menutup browser tidak menghentikan pekerjaan.

Pilihan teknis di bawah adalah rekomendasi perancang yang masih menunggu persetujuan, bukan keputusan yang pernah disebut langsung oleh pengguna.

### Pilihan yang sengaja tidak diambil

- Runner eksternal: lebih longgar untuk build besar, tetapi bertentangan dengan keputusan terakhir untuk menjalankan semuanya di VPS.
- Agent paralel: menambah tekanan memori; peran tetap terpisah secara logis tetapi dieksekusi bergantian.
- Chat-only prototype: lebih ringan tetapi tidak memenuhi kebutuhan agent yang benar-benar mengerjakan dan menguji kode.
- Redis, PostgreSQL, Kubernetes, model lokal, dan browser worker yang selalu menyala: tidak diperlukan untuk versi single-user ini.

## Scope versi pertama

### Project, agent, dan alur

- Project berasal dari Git repository yang diimpor atau repository kosong untuk project baru. Pengguna memilih baseline, perintah setup, dan perintah verifikasi sebelum eksekusi; PM boleh mengusulkan perintah tersebut untuk disetujui.
- V1 menyediakan template PM, Frontend Engineer, Backend Engineer, dan QA. Nama, instruksi, provider/model, dan dependensi tugas dapat diubah; tidak ada visual workflow builder bebas pada V1.
- PM menghasilkan rencana terstruktur: tujuan, kriteria selesai, subtask, dependensi, agent pemilik, kebutuhan tool, dan verifikasi. Server memvalidasi rencana; teks model tidak boleh langsung mengubah izin atau status.
- Dependensi membentuk DAG tanpa siklus. Hanya tugas siap yang masuk antrean; satu lease global membatasi semua project ke satu agent aktif.
- FE dan BE bekerja bergantian pada working copy terisolasi milik run yang sama agar perubahan sebelumnya tersedia bagi tugas berikutnya. Simpan diff dan checkpoint per subtask. Tidak ada dua penulis bersamaan.
- QA memeriksa hasil gabungan terhadap kriteria dan menjalankan perintah verifikasi yang disetujui. Temuan kembali menjadi subtask untuk engineer terkait, bukan sekadar pesan chat.
- Default maksimal tiga putaran perbaikan QA; setelah itu run terblokir dan PM meminta keputusan pengguna. Ini nilai usulan yang bisa diubah.
- Hasil akhir berisi ringkasan, patch/diff terhadap baseline, daftar perubahan, serta bukti pengujian. Tidak otomatis commit, push, merge ke branch utama, atau deploy hasil project.
- Perubahan baseline repository setelah rencana disetujui mengharuskan pemeriksaan ulang dan persetujuan baru; jangan menerapkan patch secara diam-diam ke baseline berbeda.

### Persetujuan dan batas otonomi

- PM dapat berdiskusi dan menyusun rencana tanpa izin eksekusi kode. Eksekusi dimulai setelah pengguna menyetujui versi rencana, baseline, perintah setup/verifikasi, dan batas penggunaan.
- Aktivitas read/write/terminal rutin hanya boleh berjalan dalam workspace run serta izin yang sudah disetujui. Permintaan baru di luar izin membuat approval baru dan menghentikan langkah terkait.
- Push, merge, deploy production, penghapusan data di luar workspace, akses kredensial baru, perluasan jaringan/izin, dan kenaikan batas biaya memerlukan persetujuan eksplisit yang spesifik. Tidak tersedia jalur untuk mematikan sandbox lewat persetujuan biasa.
- Approval disimpan di server bersama fingerprint tindakan dan versi rencana; perubahan payload membatalkan approval lama. Tombol UI bukan satu-satunya enforcement.
- Semua request model PM dan eksekusi agent memakai antrean serta lease global yang sama; tidak ada PM dan engineer aktif bersamaan. Arahan baru saat worker sibuk disimpan dan diterapkan pada batas langkah aman, bukan menyela command yang sedang berjalan.

### Provider dan autentikasi

Pisahkan adapter model berbasis API dari adapter runtime CLI native. Pilihan model, kemampuan tool, autentikasi, dan batas penggunaan tidak boleh diasumsikan seragam hanya karena format API mirip.

- **API key:** mulai dengan DeepSeek melalui protokol kompatibel OpenAI; sediakan konfigurasi provider tambahan berupa base URL HTTPS, model, dan API key. Adapter harus memeriksa kemampuan tool calling/streaming yang benar-benar dipakai. API yang tidak mendukung kontrak tersebut tidak dianggap tersedia untuk engineer.
- **ChatGPT subscription:** kandidat jalur adalah Codex resmi dengan login pengguna sendiri. Dokumentasi membedakan login langganan dan API key serta menyarankan API key untuk workflow CLI programatik; kelayakan alur orchestrator harus diuji sebelum dinyatakan didukung. Jangan memanggil endpoint internal dengan cookie/token yang diekstrak.
- **Claude subscription:** hanya lewat Claude Code resmi yang tidak dimodifikasi dan alur login Anthropic milik pengguna. Aplikasi tidak mengumpulkan, menampilkan, menyimpan sendiri, atau me-relay token Claude.ai sebagai autentikasi API custom. Auth storage tetap dikelola CLI pada volume khusus runtime, bukan tabel token aplikasi.
- **Gemini/Antigravity subscription:** gunakan jalur Antigravity CLI resmi sebagai kandidat saat ini; login Google dan headless JSON didokumentasikan. Jangan menganggap Gemini CLI lama masih menjadi jalur langganan yang sama tanpa mengecek dokumentasi terkini.
- Semua CLI berjalan di lingkungan runner terisolasi dengan auth storage khusus provider; login interaktif hanya lewat alur resmi dan akses admin privat. Form aplikasi tidak menerima password/cookie/token sesi langganan. Log proses autentikasi tidak masuk log agent atau chat.
- API key disimpan terenkripsi di server; kunci enkripsi berada di konfigurasi layanan yang tidak dipasang ke sandbox. Secret asli tidak dikirim ke browser atau masuk log, prompt, diff, dan export.
- API-key harness menggunakan broker provider pada worker agar command project tidak menerima API key. Runtime CLI memiliki batas berbeda karena proses CLI perlu mengakses auth storage-nya sendiri; dokumentasikan bahwa isolasi kredensial dari tool turunannya tidak boleh dijamin tanpa bukti. Project tidak tepercaya tidak boleh memakai mode CLI berlangganan sebelum batas ini divalidasi.
- Koneksi memiliki status nyata: belum dikonfigurasi, perlu login, siap, rate-limited, atau tidak tersedia. Jangan menampilkan badge connected hanya karena form berhasil disimpan.
- Adapter CLI wajib membuktikan bahwa izin tool, penghentian, pencatatan command, dan approval tambahan dapat ditegakkan melalui kontrol resmi runtime. Bila kontraknya tidak bisa dipenuhi, adapter tetap tidak tersedia; jangan mengaktifkan mode bypass permission agar alur terlihat berjalan.
- Tidak ada fallback otomatis dari langganan ke API berbayar. Perubahan jalur tagihan memerlukan persetujuan.
- Delivery dilakukan bertahap: alur penuh berbasis API dahulu, kemudian adapter Codex, Claude Code, dan Antigravity masing-masing melewati autentikasi resmi, tool execution, resume, cancellation, dan uji resource. Dukungan langganan tetap target produk, bukan dihapus dari scope atau diganti simulasi.
- Jika kredensial, kebijakan provider, atau kapasitas VPS menghalangi adapter, laporkan blocker secara spesifik. Jangan menyatakan seluruh target provider selesai saat hanya satu adapter bekerja.

### Resource dan keamanan pada VPS

- Satu worker dan satu agent aktif secara global; container hanya hidup saat dibutuhkan. Native CLI dijalankan di dalam jatah sandbox yang sama, bukan proses host tanpa limit.
- Default usulan sandbox: CPU 1 core, RAM 768 MiB, tanpa swap tambahan untuk container, PID limit 128, dan timeout 15 menit per percobaan. Timeout login menunggu pengguna dikelola terpisah; jangan membiarkan job agent memegang lease sambil menunggu login.
- Nilai tersebut adalah batas proteksi, bukan jaminan project akan muat. Lakukan uji beban pada VPS target sebelum mengklaim kelayakan.
- Utamakan rootless Docker dengan cgroup v2/systemd dan controller terdelegasi. Preflight harus membuktikan batas CPU, memori, dan PID benar-benar efektif; rootless Docker bisa mengabaikan flag cgroup bila prasyarat tidak terpenuhi. Gagal preflight berarti eksekusi dinonaktifkan, bukan fallback ke proses host.[7]
- Sandbox tanpa privileged mode, tanpa host network, tanpa Docker socket, tanpa mount root host, tanpa database/kredensial control plane, dan berjalan sebagai user non-root. Worker berada pada akun OS khusus tanpa hak deploy/administrasi yang diwariskan ke job.
- Koneksi sandbox ke host/control plane, metadata service, loopback host, dan jaringan privat harus ditolak dan diuji. Akses keluar hanya untuk kebutuhan provider/source/package yang disetujui; jangan menganggap default network Docker sudah memberi jaminan ini.
- Container adalah lapisan pembatas pada kernel yang sama, bukan VM dan bukan jaminan aman menjalankan kode arbitrer bermusuhan. Jangan menonaktifkan seccomp atau proteksi host untuk membuat provider bekerja.
- Hindari preload semua CLI/image. Mulai dari image runtime project yang dipilih; toolchain tambahan dipasang/dipakai hanya setelah persetujuan dan pemeriksaan disk.
- Sebelum run, periksa RAM tersedia, disk, serta runtime yang diperlukan. Host terlalu penuh → queued/blocked dengan penjelasan, bukan mencoba terus sampai host mati.
- Log tersimpan dibatasi dan dipaginasi; output command dipotong dengan metadata truncation. Log aktif memiliki batas 10 MiB per run dan retensi default 14 hari untuk log/run sementara yang sudah terminal. Artifact akhir dipertahankan sampai pengguna menghapusnya; hentikan run baru ketika disk tidak mencukupi.
- Swap host tidak diubah otomatis dan bukan alasan untuk menaikkan limit container. Browser testing/headless browser hanya diaktifkan bila pemeriksaan kapasitas dan pengujian membuktikannya aman.

### State persisten, kegagalan, dan biaya

- SQLite mode WAL menyimpan project, agent, provider metadata, percakapan, run, subtask, dependensi, approval, lease, event, hasil QA, artifact metadata, dan catatan penggunaan. File artifact disimpan terpisah dari database.
- Klaim antrean dan transisi status dilakukan atomik. Event mempunyai ID monoton agar browser dapat melanjutkan stream setelah reconnect tanpa mengulang tugas.
- State run: `draft`, `awaiting_approval`, `queued`, `running`, `awaiting_review`, `blocked`, `interrupted`, `failed`, `done`, `cancelled`. Perubahan stage/QA tersimpan sebagai event/subtask, bukan boolean terpisah yang saling bertentangan.
- Worker heartbeat dan lease memiliki expiry. Saat restart, hentikan/reconcile sandbox lama terlebih dahulu, lalu tandai eksekusi yang tidak bisa dipastikan sebagai interrupted. Jangan menjalankan ulang command dengan side effect secara otomatis.
- Resume memakai checkpoint yang diverifikasi dan persetujuan pengguna. Cancel menghentikan process tree/container, memastikan tidak ada proses yatim, dan menyimpan hasil parsial sebagai cancelled.
- OOM, timeout, auth gagal, rate limit, provider error, dan verifikasi gagal memiliki alasan terpisah. Tidak ada status sukses berdasarkan ringkasan model saja.
- Sebelum run API pertama, pengguna wajib mengatur batas penggunaan berhingga. Implementasi harus memiliki request/tool-call cap dan output-token cap; estimasi biaya bukan jaminan tagihan absolut.
- Bila pricing/usage provider tidak diketahui, tampilkan tidak diketahui, bukan nol. Batas subscription ditampilkan sesuai informasi yang benar-benar tersedia; jangan mengarang sisa kuota atau harga per token langganan.
- Output akhir membedakan verified, failed, dan not-run. Run `done` memerlukan semua kriteria wajib verified. Project yang tidak punya pemeriksaan terotomasi tetap memerlukan verifikasi manual eksplisit sebelum done.

## Tampilan dan interaksi

- Referensi utama adalah PNG pengguna, bukan template brand lain. Jangan menyalin nama, angka, logo, atau grafik dashboard bisnis dari gambar.
- Pertahankan Geist yang sudah dipakai project. Warna usulan, bukan hasil sampling presisi: background `#F7F8F2`, teks/outline `#173A32`, accent `#D7F75B`, kartu `#FFFFFF`, pastel lavender/peach untuk ikon. Kartu radius 20 px, outline 1–2 px, shadow offset tanpa blur berlebihan.
- Desktop: sidebar kiri dan content area; mobile: navigasi ringkas, panel detail bertumpuk, tanpa horizontal scrolling untuk tindakan utama. Fokus keyboard, label form, kontras, dan status tidak boleh bergantung pada warna saja.
- Navigasi: Overview, Projects, Agents, Tasks, Approvals, Providers; pengaturan akses/resource berada pada Settings sekunder.
- Overview menonjolkan pekerjaan aktif, antrean, dan tindakan yang perlu keputusan. Angka berasal dari data nyata; kondisi awal memakai empty state, bukan chart/statistik palsu.
- Project detail memuat chat PM, daftar tugas berdependensi, agent pemilik, serta stage saat ini. Inspector tugas memperlihatkan diff, command, exit code, log terpotong bila perlu, hasil QA, dan tombol tindakan sesuai state.
- Agents mengubah peran/instruksi dan provider; Providers menampilkan autentikasi/capability/health nyata tanpa membuka secret. Approvals memperlihatkan tindakan persis, risiko, konteks, dan perubahan sejak persetujuan sebelumnya.
- UI awal menggunakan Bahasa Indonesia; identifier provider/runtime dipertahankan. Prompt tugas boleh memakai bahasa pengguna. Tidak ada pekerjaan i18n penuh atau dark mode pada V1.
- Tidak ada editor kode lengkap, drag-and-drop org chart, animasi 3D, atau penggunaan aset GLB yang tidak diminta.

## Deployment dan batas operasional

- Target: satu VPS Ubuntu yang sama. Rekomendasi target awal Ubuntu 24.04 LTS; versi aktual dan CPU architecture harus dibuktikan pada tahap deployment, bukan diasumsikan dari kata Ubuntu.
- Jalankan web, worker, dan rootless daemon sebagai layanan terkelola yang restart otomatis. Reverse proxy HTTPS melindungi aplikasi; backend tidak diekspos langsung ke internet.
- Satu akun owner, tanpa public signup. Password di-hash dan diverifikasi di server; session cookie HttpOnly/Secure/SameSite, proteksi CSRF untuk mutasi, pembatasan login, dan pemeriksaan origin untuk stream/aksi. API dan stream juga wajib terautentikasi.
- Akses privat diperlukan untuk setup auth CLI; jangan mempublikasikan terminal admin, callback proxy umum, atau Docker API demi kemudahan login.
- Build release orchestrator direkomendasikan di lingkungan pengembangan/CI dan deploy artifact production yang kompatibel dengan VPS. Runtime web, worker, dan project agent tetap di VPS. Bila pengguna hanya menyediakan VPS untuk build, uji build dalam maintenance window tanpa agent aktif dan laporkan bila tidak muat; jangan memaksa OOM.
- Database, artifact, auth volume native CLI, dan encryption key memerlukan backup terpisah dengan izin akses ketat. Backup SQLite memakai metode konsisten, bukan menyalin file utama saja saat WAL aktif. Restore harus diuji sebelum disebut siap pakai.
- Tidak ada deployment ke VPS, perubahan firewall, instalasi paket, pengisian credential, atau commit yang diizinkan hanya karena desain ini disetujui; minta akses/otorisasi tindakan tersebut secara spesifik pada waktu eksekusi.

## Tahap implementasi setelah desain disetujui

1. Tambahkan fondasi test, autentikasi owner, schema/migration SQLite, serta UI shell mengikuti referensi; seluruh data operasional berasal dari backend.
2. Buktikan sandbox berlimit dan lifecycle job dengan fixture kecil; preflight harus fail-closed sebelum menghubungkan agent ke tool.
3. Bangun satu jalur API dengan tool loop nyata, kontrak rencana PM, approval, antrean persisten, FE/BE serial, QA, cancel, dan pemulihan interrupted.
4. Tambahkan adapter native CLI satu per satu dengan uji autentikasi resmi dan resource; tandai koneksi yang belum teruji secara jujur.
5. Lengkapi observabilitas, backup/restore, akses HTTPS, dan acceptance test di VPS target; tidak ada klaim siap production hanya dari build lokal.

Rencana implementasi berikutnya harus memecah tahap tersebut menjadi task kecil dengan path, kontrak, kode/test yang dibutuhkan, siklus RED–GREEN, dan perintah verifikasi yang benar-benar ditambahkan. Jangan menambahkan script test fiktif ke instruksi repo sebelum script itu ada.

## Tests / validation yang wajib dibuktikan

- Baseline repo saat ini: `bun run lint` dan `bun run build` adalah script yang tersedia, bukan bukti keduanya sudah dijalankan dalam sesi desain ini.
- Unit/domain: validasi DAG, pemilihan tugas siap, transisi status, fingerprint approval, tiga siklus QA, serta perhitungan cap/reservasi request tanpa bergantung pada teks model.
- Integrasi SQLite: dua pemanggil tidak bisa memperoleh lease bersamaan; restart/reconnect tidak menggandakan command; approval dengan payload lama ditolak.
- Sandbox: CPU/memori/PID limit efektif, timeout/cancel membunuh proses turunan, akses host/metadata/secret ditolak, network policy efektif, dan disk/log cap dipatuhi. Uji destruktif hanya dalam sandbox test yang dibatasi.
- Alur end-to-end fixture: chat tujuan → rencana PM → approve → FE → BE → QA gagal → perbaikan → QA lulus → diff dan bukti. Rekam perintah, exit code, baseline, dan artifact; tidak cukup hanya melihat pesan QA.
- Skenario kegagalan: provider 401/429/5xx, tool output rusak, login kedaluwarsa, disconnect stream, restart worker, OOM, disk penuh, baseline berubah, serta user cancel saat command berjalan.
- UI: login/empty/loading/error/approval/cancel, navigasi keyboard, mobile viewport, status antrean serial, dan pemeriksaan visual terhadap PNG referensi.
- Uji adapter dibagi menjadi fixture kontrak deterministik dan smoke test nyata dengan akun milik pengguna. Fixture tidak boleh diklaim sebagai bukti koneksi provider sungguhan.
- Target VPS: aplikasi tetap responsif saat satu job berjalan dan setelah job dihentikan karena limit; semua provider yang dinyatakan siap harus punya bukti nyata. Project besar yang gagal muat dilaporkan blocked, bukan memicu peningkatan paralelisme.

## Risks, tradeoffs, dan hal yang belum dibuktikan

- RAM 2 GB dapat membatasi CLI modern, dependency install, build Next.js project target, dan browser QA. Serialisasi dan hard limit melindungi host tetapi tidak membuat semua project pasti bisa dikerjakan.
- Rootless Docker resource/network isolation memerlukan dukungan OS dan konfigurasi yang harus diverifikasi. Docker bukan batas keamanan sempurna terhadap kode bermusuhan.[7][8]
- Kebijakan serta fitur provider dapat berubah; otorisasi langganan tidak boleh diperlakukan sebagai API umum. Kesimpulan dokumentasi belum merupakan uji integrasi langsung.[2][3][4][5]
- Satu VPS adalah single point of failure; restore, retensi artifact, dan recovery lebih penting daripada dashboard statistik.
- Provider pertama yang akan diuji, akun/key yang tersedia, Git credential private repo, domain, dan versi Ubuntu belum diberikan. Ini input setup/deployment, bukan alasan untuk mengarang integrasi berhasil.
- Tidak ada pertanyaan produk besar yang masih membutuhkan jawaban sebelum menyusun rencana; pilihan teknis usulan di dokumen ini tetap membutuhkan persetujuan pengguna.

## Sources

Sumber berikut dibaca selama brainstorming; belum ada CLI/provider atau VPS target yang diuji.

1. https://docs.paperclip.ing/reference/adapters/overview/ — pemisahan control plane dan runtime melalui adapter.
2. https://learn.chatgpt.com/docs/auth — autentikasi Codex via ChatGPT/API key dan pembedaan penggunaan programatik.
3. https://code.claude.com/docs/en/legal-and-compliance — penggunaan binary Claude Code resmi, auth milik pengguna, serta larangan intermediasi token Claude.ai.
4. https://antigravity.google/docs/getting-started — pilihan surface dan autentikasi Google/API.
5. https://antigravity.google/docs/cli/headless/ — headless dengan auth tersimpan, JSON, streaming, dan status error.
6. https://api-docs.deepseek.com/ — API key serta kompatibilitas protokol; tidak membuktikan kesamaan semua kemampuan model.
7. https://docs.docker.com/engine/security/rootless/tips/ — resource control rootless membutuhkan cgroup v2/systemd dan controller yang tersedia.
8. https://docs.docker.com/engine/containers/resource_constraints/ — default tanpa limit serta perilaku memori/swap yang perlu dikonfigurasi eksplisit.
