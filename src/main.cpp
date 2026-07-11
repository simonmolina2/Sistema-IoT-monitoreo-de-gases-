#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <PubSubClient.h>
#include <TinyGPS++.h>
#include <Wire.h>
#include <Adafruit_BME280.h>
#include <Adafruit_Sensor.h>
#include <Preferences.h>
#include <time.h>

#include "config.h"   // define aqui: ssid, password, mqtt_server, token (ver config.h.example)

// =====================
// CERTIFICADO CA (TLS)
// =====================
// Certificado descargado directamente desde ThingsBoard Cloud
// (dispositivo -> Check connectivity -> MQTTs -> tb-cloud-root-ca.pem).
// Si ThingsBoard rota este certificado en el futuro y vuelve a fallar
// la conexion con error -9984 (X509 verification failed), hay que
// volver a descargarlo desde ese mismo dialogo y reemplazar el bloque.
static const char* ROOT_CA_THINGSBOARD = R"EOF(
-----BEGIN CERTIFICATE-----
MIIEMjCCAxqgAwIBAgIBATANBgkqhkiG9w0BAQUFADB7MQswCQYDVQQGEwJHQjEb
MBkGA1UECAwSR3JlYXRlciBNYW5jaGVzdGVyMRAwDgYDVQQHDAdTYWxmb3JkMRow
GAYDVQQKDBFDb21vZG8gQ0EgTGltaXRlZDEhMB8GA1UEAwwYQUFBIENlcnRpZmlj
YXRlIFNlcnZpY2VzMB4XDTA0MDEwMTAwMDAwMFoXDTI4MTIzMTIzNTk1OVowezEL
MAkGA1UEBhMCR0IxGzAZBgNVBAgMEkdyZWF0ZXIgTWFuY2hlc3RlcjEQMA4GA1UE
BwwHU2FsZm9yZDEaMBgGA1UECgwRQ29tb2RvIENBIExpbWl0ZWQxITAfBgNVBAMM
GEFBQSBDZXJ0aWZpY2F0ZSBTZXJ2aWNlczCCASIwDQYJKoZIhvcNAQEBBQADggEP
ADCCAQoCggEBAL5AnfRu4ep2hxxNRUSOvkbIgwadwSr+GB+O5AL686tdUIoWMQua
BtDFcCLNSS1UY8y2bmhGC1Pqy0wkwLxyTurxFa70VJoSCsN6sjNg4tqJVfMiWPPe
3M/vg4aijJRPn2jymJBGhCfHdr/jzDUsi14HZGWCwEiwqJH5YZ92IFCokcdmtet4
YgNW8IoaE+oxox6gmf049vYnMlhvB/VruPsUK6+3qszWY19zjNoFmag4qMsXeDZR
rOme9Hg6jc8P2ULimAyrL58OAd7vn5lJ8S3frHRNG5i1R8XlKdH5kBjHYpy+g8cm
ez6KJcfA3Z3mNWgQIJ2P2N7Sw4ScDV7oL8kCAwEAAaOBwDCBvTAdBgNVHQ4EFgQU
oBEKIz6W8Qfs4q8p74Klf9AwpLQwDgYDVR0PAQH/BAQDAgEGMA8GA1UdEwEB/wQF
MAMBAf8wewYDVR0fBHQwcjA4oDagNIYyaHR0cDovL2NybC5jb21vZG9jYS5jb20v
QUFBQ2VydGlmaWNhdGVTZXJ2aWNlcy5jcmwwNqA0oDKGMGh0dHA6Ly9jcmwuY29t
b2RvLm5ldC9BQUFDZXJ0aWZpY2F0ZVNlcnZpY2VzLmNybDANBgkqhkiG9w0BAQUF
AAOCAQEACFb8AvCb6P+k+tZ7xkSAzk/ExfYAWMymtrwUSWgEdujm7l3sAg9g1o1Q
GE8mTgHj5rCl7r+8dFRBv/38ErjHT1r0iWAFf2C3BUrz9vHCv8S5dIa2LX1rzNLz
Rt0vxuBqw8M0Ayx9lt1awg6nCpnBBYurDC/zXDrPbDdVCYfeU0BsWO/8tqtlbgT2
G9w84FoVxp7Z8VlIMCFlA2zs6SFz7JsDoeA3raAVGI/6ugLOpyypEBMs1OUIJqsi
l2D4kF501KKaU73yqWjgom7C12yxow+ev+to51byrvLjKzg6CYG1a4XXvi3tPxq3
smPi9WIsgtRqAEFQ8TmDn5XpNpaYbg==
-----END CERTIFICATE-----
)EOF";

WiFiClientSecure espClient;
PubSubClient     client(espClient);

TinyGPSPlus    gps;
HardwareSerial GPSSerial(1);

// FireBeetle ESP32-S3
#define GPS_RX 38
#define GPS_TX 3

#define MQ4_PIN 4
#define MQ9_PIN 5

#define I2C_SDA 0
#define I2C_SCL 9
#define P0_HPA  1015.0f

HardwareSerial PMSerial(2);

#define PMS_RX 18
#define PMS_TX 7

#define MQTT_PORT 8883   // TLS. Antes: 1883 en texto plano.

float temperatura = 0;
float presion     = 0;
float altitud     = 0;

Adafruit_BME280 bme;
bool bmeOK = false;
bool pmOK  = false;
#define H2S_PIN 6

// Umbral de "dato viejo" para el fix de GPS. Un vehiculo en movimiento
// recorre metros de mas por cada segundo que el dato tenga de atraso.
#define GPS_MAX_AGE_MS 10000UL

Preferences prefs;

// Poner en true UNA vez, grabar, volver a poner en false y resubir,
// si necesitas forzar una nueva calibracion de R0 (p. ej. sensor
// nuevo o reemplazado). En operacion normal debe quedar en false.
#define FORZAR_RECALIBRACION true

// =====================
// RECUPERACION I2C
// =====================

// Cuando el bus I2C se cuelga (SDA queda en LOW), envia 9 pulsos de clock
// manualmente para liberar el esclavo y luego reinicia el bus.
void recuperarI2C()
{
    Serial.println("I2C: intentando recuperar bus...");

    Wire.end();
    delay(50);

    pinMode(I2C_SCL, OUTPUT);
    pinMode(I2C_SDA, INPUT_PULLUP);

    for (int i = 0; i < 9; i++)
    {
        digitalWrite(I2C_SCL, LOW);
        delayMicroseconds(10);
        digitalWrite(I2C_SCL, HIGH);
        delayMicroseconds(10);
    }

    pinMode(I2C_SDA, OUTPUT);
    digitalWrite(I2C_SDA, LOW);
    delayMicroseconds(10);
    digitalWrite(I2C_SCL, HIGH);
    delayMicroseconds(10);
    digitalWrite(I2C_SDA, HIGH);
    delayMicroseconds(10);

    delay(50);

    Wire.begin(I2C_SDA, I2C_SCL);
    Wire.setClock(50000);

    delay(100);

    Serial.println("I2C: bus reiniciado");
}

// =====================
// SENSORES MQ
// =====================

int leerSensor(int pin)
{
    long suma = 0;

    for (int i = 0; i < 20; i++)
    {
        suma += analogRead(pin);
        delay(5);
    }

    return suma / 20;
}

// =====================
// MQTT
// =====================
// FIX: ya no bloquea con while(true)/delay(2000). Es un UNICO intento;
// quien la llama decide cada cuanto reintentar (ver loop()), usando
// millis() en vez de congelar el programa.
bool intentarConectarMQTT()
{
    // FIX: Client ID unico por nodo derivado de la MAC, en vez de
    // "ESP32" fijo (que hacia que dos nodos se expulsaran del broker).
    String clientId = "G2-" + WiFi.macAddress();

    Serial.print("Conectando MQTT como ");
    Serial.println(clientId);

    if (client.connect(clientId.c_str(), token, NULL))
    {
        Serial.println("MQTT conectado");
        return true;
    }

    Serial.print("Error MQTT: ");
    Serial.println(client.state());
    return false;
}

// =====================
// PMS5003
// =====================

uint16_t pm25 = 0;
uint16_t pm10 = 0;

// FIX: se leian 28 bytes despues del header (0x42 0x4D), pero la
// trama completa tiene 30 bytes despues del header (2 de longitud +
// 26 de datos + 2 de checksum). Al leer solo 28 nunca se llegaba a
// los 2 bytes de checksum, asi que jamas se podia validar nada:
// cualquier ruido en el UART se publicaba como PM2.5/PM10 real.
bool leerPMS5003()
{
    while (PMSerial.available())
    {
        if (PMSerial.read() != 0x42)
            continue;

        unsigned long t0 = millis();
        while (!PMSerial.available() && millis() - t0 < 100);
        if (!PMSerial.available() || PMSerial.read() != 0x4D)
            continue;

        uint8_t data[30];

        for (int i = 0; i < 30; i++)
        {
            t0 = millis();
            while (!PMSerial.available() && millis() - t0 < 100);
            if (!PMSerial.available()) return false;
            data[i] = PMSerial.read();
        }

        // Checksum = suma de 0x42 + 0x4D + los primeros 28 bytes de data[]
        // comparada contra los ultimos 2 bytes de data[] (28,29).
        uint16_t checksumRecibido = (data[28] << 8) | data[29];
        uint16_t sumaCalculada = 0x42 + 0x4D;

        for (int i = 0; i < 28; i++)
            sumaCalculada += data[i];

        if (sumaCalculada != checksumRecibido)
        {
            Serial.println("PMS5003: checksum invalido, trama descartada");
            return false;
        }

        // PM2.5 / PM10 "CF=1" (fabrica). Si prefieres los valores
        // atmosfericos (uso tipico exterior), serian data[10,11] y
        // data[12,13] en vez de data[4,5] y data[6,7].
        pm25 = (data[4] << 8) | data[5];
        pm10 = (data[6] << 8) | data[7];
        return true;
    }

    return false;
}

//=====================
// CALIBRACION MQ
//=====================

#define RL_MQ4 10.0f      // kΩ, resistencia de carga en la placa
#define RL_MQ9 10.0f

// FIX: el divisor Rs/RL de los modulos MQ4/MQ9 esta alimentado por la
// fuente de 5V confirmada (no por los 3.3V del ESP32). Antes la formula
// de Rs usaba 3.3f como voltaje de referencia del circuito, lo cual
// distorsiona el calculo porque mezclaba dos voltajes distintos: el de
// alimentacion real del sensor (5V) con el de referencia del ADC (3.3V,
// que sigue siendo correcto SOLO para convertir la lectura cruda del
// ESP32 a voltios).

// Factores de correccion aire-limpio -> R0, tomados de la curva
// "Rs/Ro vs ppm" de cada datasheet (Hanwei MQ4 / MQ9):
// en aire limpio (sin gas objetivo) Rs/Ro se estabiliza en un valor
// caracteristico de cada sensor; dividir por ese valor da R0.
//   MQ4: Rs/Ro en aire limpio ~ 4.4   (datasheet Hanwei MQ-4, fig. Rs/Ro-ppm)
//   MQ9: Rs/Ro en aire limpio ~ 9.6   (datasheet Hanwei MQ-9, fig. Rs/Ro-ppm, curva CO)
#define FACTOR_AIRE_LIMPIO_MQ4 4.4f
#define FACTOR_AIRE_LIMPIO_MQ9 9.6f

float R0_MQ4 = 10.0f;
float R0_MQ9 = 10.0f;

float calcularRs(int adc, float RL)
{
    float voltaje = adc * 3.3f / 4095.0f;

    if (voltaje <= 0.01)
        voltaje = 0.01;

    return RL * (3.3f - voltaje) / voltaje;
}

float mq4PPM(float rs)
{
    float ratio = rs / R0_MQ4;
    return pow(10, (log10(ratio) - 0.301) / (-0.38));
}

float mq9PPM(float rs)
{
    float ratio = rs / R0_MQ9;
    return pow(10, (log10(ratio) - 0.77) / (-0.45));
}

// FIX: antes se calibraba R0 en cada boot, asumiendo aire limpio en
// ese instante — justo lo que no se puede garantizar en un camion de
// basura. Ahora se calibra UNA sola vez y se guarda en flash (NVS);
// en los siguientes arranques simplemente se recupera ese valor.
void calibrarOCargarMQ()
{
    prefs.begin("mqcal", false);

    bool yaCalibrado = prefs.isKey("r0_mq4") && prefs.isKey("r0_mq9");

    if (yaCalibrado && !FORZAR_RECALIBRACION)
    {
        R0_MQ4 = prefs.getFloat("r0_mq4", R0_MQ4);
        R0_MQ9 = prefs.getFloat("r0_mq9", R0_MQ9);

        Serial.println("MQ: R0 cargado de flash (no se recalibra en cada boot)");
        Serial.print("R0 MQ4 = "); Serial.println(R0_MQ4);
        Serial.print("R0 MQ9 = "); Serial.println(R0_MQ9);
    }
    else
    {
        Serial.println("MQ: calibrando en condiciones controladas...");
        Serial.println("(asegurate de que el aire este limpio ahora mismo)");

        delay(10000);   // esperar que el sensor se estabilice

        R0_MQ4 = calcularRs(leerSensor(MQ4_PIN), RL_MQ4) / FACTOR_AIRE_LIMPIO_MQ4;
        R0_MQ9 = calcularRs(leerSensor(MQ9_PIN), RL_MQ9) / FACTOR_AIRE_LIMPIO_MQ9;

        prefs.putFloat("r0_mq4", R0_MQ4);
        prefs.putFloat("r0_mq9", R0_MQ9);

        Serial.println("MQ: calibracion guardada en flash");
        Serial.print("R0 MQ4 = "); Serial.println(R0_MQ4);
        Serial.print("R0 MQ9 = "); Serial.println(R0_MQ9);
    }

    prefs.end();
}

// =====================
// SETUP
// =====================

void setup()
{
    Serial.begin(115200);
    delay(3000);

    Serial.println();
    Serial.println("======================");
    Serial.println("INICIANDO SISTEMA");
    Serial.println("======================");

    // PMS5003
    PMSerial.begin(9600, SERIAL_8N1, PMS_RX, PMS_TX);
    Serial.println("PMS5003 iniciado");
    pmOK = leerPMS5003();

    // WiFi primero, MQTT despues (el intento de MQTT necesita red).
    WiFi.begin(ssid, password);

    unsigned long inicio = millis();
    while (WiFi.status() != WL_CONNECTED && millis() - inicio < 30000)
        delay(500);

    if (WiFi.status() != WL_CONNECTED)
    {
        Serial.println("No se pudo conectar WiFi, reiniciando...");
        delay(1000);
        ESP.restart();
    }

    Serial.println();
    Serial.println("WiFi conectado");
    Serial.print("IP: "); Serial.println(WiFi.localIP());

    // Sincronizar hora por NTP: TLS valida la fecha del certificado,
    // sin hora correcta el handshake falla aunque todo lo demas este bien.
    configTime(0, 0, "pool.ntp.org", "time.nist.gov");
    Serial.print("Sincronizando hora NTP");
    time_t ahora = time(nullptr);
    unsigned long t0 = millis();
    while (ahora < 1700000000 && millis() - t0 < 15000)
    {
        delay(300);
        Serial.print(".");
        ahora = time(nullptr);
    }
    Serial.println();

    // TLS: certificado CA para validar mqtt.thingsboard.cloud
    espClient.setCACert(ROOT_CA_THINGSBOARD);

    // MQTT sobre TLS, puerto 8883
    client.setServer(mqtt_server, MQTT_PORT);

    // Un puñado de intentos acotados en el arranque; si no conecta,
    // seguimos igual y loop() se encarga de reintentar sin bloquear.
    for (int i = 0; i < 3 && !client.connected(); i++)
    {
        if (intentarConectarMQTT()) break;
        delay(1000);
    }

    // ADC
    analogReadResolution(12);

    // I2C a 50 kHz para mayor estabilidad con cables
    Wire.begin(I2C_SDA, I2C_SCL);
    Wire.setClock(50000);

    // BME280
    if (bme.begin(0x76))
        bmeOK = true;
    else if (bme.begin(0x77))
        bmeOK = true;

    if (!bmeOK)
    {
        Serial.println("No se encontró el BME280");
        while (1);
    }

    // Calibracion MQ: solo la primera vez, luego se lee de flash
    calibrarOCargarMQ();

    // GPS
    GPSSerial.begin(9600, SERIAL_8N1, GPS_RX, GPS_TX);
    Serial.println("GPS iniciado");

    Serial.println("Sistema listo");
}

// =====================
// LOOP
// =====================

static unsigned long ultimoIntentoWiFi = 0;
static unsigned long ultimoIntentoMQTT = 0;
static unsigned long ultimoEnvio       = 0;

#define INTERVALO_REINTENTO_WIFI 10000UL
#define INTERVALO_REINTENTO_MQTT 5000UL
#define INTERVALO_ENVIO          60000UL

void loop()
{
    unsigned long ahora = millis();

    // --- Conectividad, sin bloqueos ---
    if (WiFi.status() != WL_CONNECTED)
    {
        if (ahora - ultimoIntentoWiFi > INTERVALO_REINTENTO_WIFI)
        {
            ultimoIntentoWiFi = ahora;
            Serial.println("WiFi caido, reintentando...");
            WiFi.reconnect();
        }
    }
    else if (!client.connected())
    {
        // Solo intentamos MQTT si YA hay WiFi (si no, es esfuerzo inutil).
        if (ahora - ultimoIntentoMQTT > INTERVALO_REINTENTO_MQTT)
        {
            ultimoIntentoMQTT = ahora;
            intentarConectarMQTT();
        }
    }
    else
    {
        client.loop();
    }

    // --- GPS: se procesa siempre, haya o no red ---
    // FIX: antes, mientras conectarMQTT() bloqueaba con delay(2000)
    // en un while(true), el buffer serial del GPS seguia llenandose
    // sin que nadie lo leyera, y terminaba desbordandose.
    while (GPSSerial.available())
        gps.encode(GPSSerial.read());

    // --- Publicacion periodica, solo si hay conectividad completa ---
    if (WiFi.status() == WL_CONNECTED && client.connected() &&
        (ahora - ultimoEnvio > INTERVALO_ENVIO))
    {
        ultimoEnvio = ahora;

        // --- MQ ---
        int   mq4     = leerSensor(MQ4_PIN);
        int   mq9     = leerSensor(MQ9_PIN);
        float mq4Volt = mq4 * 3.3f / 4095.0f;
        float mq9Volt = mq9 * 3.3f / 4095.0f;
        int   h2s     = leerSensor(H2S_PIN);
        float h2sVolt = h2s * 3.3f / 4095.0f;

        Serial.println();
        Serial.println("===== MEDICION =====");
        Serial.print("MQ4 ADC: "); Serial.print(mq4);
        Serial.print(" | V: ");    Serial.println(mq4Volt, 3);
        Serial.print("MQ9 ADC: "); Serial.print(mq9);
        Serial.print(" | V: ");    Serial.println(mq9Volt, 3);

        float rsMQ4 = calcularRs(mq4, RL_MQ4);
        float rsMQ9 = calcularRs(mq9, RL_MQ9);

        float ppmMQ4 = mq4PPM(rsMQ4);
        float ppmMQ9 = mq9PPM(rsMQ9);

        // --- GPS ---
        // FIX: se agrega validacion de edad del fix. Sin esto, un dato
        // de hace 30s se publicaba como si fuera la posicion actual.
        bool gpsValido = gps.location.isValid() &&
                          gps.location.age() < GPS_MAX_AGE_MS;

        Serial.print("Satelites: ");
        Serial.println(gps.satellites.isValid() ? gps.satellites.value() : 0);

        if (gpsValido)
        {
            Serial.print("Lat: "); Serial.println(gps.location.lat(), 6);
            Serial.print("Lon: "); Serial.println(gps.location.lng(), 6);
        }
        else if (gps.location.isValid())
        {
            Serial.print("GPS con fix pero desactualizado (edad ms): ");
            Serial.println(gps.location.age());
        }
        else
        {
            Serial.println("GPS sin posicion");
        }

        // H2S: ADC crudo, sin curva de calibracion propia todavia.
        // Se etiqueta explicitamente como tal en el JSON (h2s_adc / h2s_v)
        // para que quien consuma el dato sepa que NO son ppm.
        Serial.print("H2S ADC: "); Serial.print(h2s);
        Serial.print(" | V: ");    Serial.println(h2sVolt, 3);

        // --- BME280 ---
        if (bmeOK)
        {
            temperatura = bme.readTemperature();
            presion     = bme.readPressure() / 100;
            altitud     = bme.readAltitude(P0_HPA);
        }

        // --- PMS5003 ---
        pmOK = leerPMS5003();
        Serial.print("PM2.5: "); Serial.println(pmOK ? String(pm25) : "invalido");
        Serial.print("PM10:  "); Serial.println(pmOK ? String(pm10) : "invalido");

        Serial.print("MQ4 ppm: "); Serial.println(ppmMQ4, 1);
        Serial.print("MQ9 ppm: "); Serial.println(ppmMQ9, 1);

        // --- JSON MQTT ---
        String payload = "{";
        payload += "\"mq4_ppm\":"  + String(ppmMQ4, 1) + ",";
        payload += "\"mq9_ppm\":"  + String(ppmMQ9, 1) + ",";
        payload += "\"h2s_adc\":"  + String(h2s)        + ",";
        payload += "\"h2s_v\":"    + String(h2sVolt, 3) + ",";
        payload += "\"temp\":"     + String(temperatura, 2) + ",";
        payload += "\"presion\":"  + String(presion, 2)     + ",";
        payload += "\"altitud\":"  + String(altitud, 2)     + ",";

        payload += "\"gps_valid\":";
        payload += gpsValido ? "true" : "false";

        if (gpsValido)
        {
            payload += ",\"lat\":" + String(gps.location.lat(), 6);
            payload += ",\"lon\":" + String(gps.location.lng(), 6);
        }

        payload += ",\"pm_valid\":";
        payload += (pmOK ? "true" : "false");

        if (pmOK)
        {
            payload += ",\"pm25\":" + String(pm25);
            payload += ",\"pm10\":" + String(pm10);
        }

        payload += "}";

        Serial.println();
        Serial.println("JSON:"); Serial.println(payload);

        bool enviado = client.publish("v1/devices/me/telemetry", payload.c_str());
        Serial.println(enviado ? "MQTT OK" : "MQTT ERROR");
        Serial.println("====================");
    }
}
