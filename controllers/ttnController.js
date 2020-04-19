const mqtt = require("mqtt");
const client = mqtt.connect({
  username: process.env.MQTT_USER,
  port: process.env.MQTT_PORT,
  password: process.env.MQTT_PASSWORD
});
const recordModel = require("../models/recordModel");
const deviceModel = require("../models/deviceModel");

const opts = {
  port: 1, // LoRaWAN FPort
  confirmed: false, // Whether the downlink should be confirmed by the device
  payload_fields: { action: "ChangeMode" } // Base64 encoded payload: [0x01, 0x02, 0x03, 0x04] or JSON
};
// parqueadero18
// parqueadermua
// circunvalarferrocarril
// circunvalarregional
// circunvalarbarranquilla
const format=message=>{

  let split=message.split(",");
  let stateSplit;
  let decode;
  if (split[0]==='1'){

    if (split[2]==='0'){
      stateSplit="Ocupado";
    }
    else stateSplit="Libre";
    decode={
      port:split[0]*1,
      dev_id:split[1],
      state:stateSplit,
      battery:split[3]
    }
  }
  else{
    decode={
      port:split[0]*1,
      dev_id:split[1],
      battery:split[2]
    }
  }
  return decode;

}

const initIo = io => {

  io.on("connection", socket => {
    socket.on("Join", room => {
      socket.join(room);
      deviceModel.find({ "real_location.sector": room }, (err, list) => {
        socket.emit("initial", list);
      });
    });
    socket.on("disconnect", () => {
      socket.disconnect(0);
    });
  });
};

const saveRecord = async uplink => {
  const { state, battery } = uplink;
  //truchazo para no tracker mensajes de un dispositivo dormido
  const dev = await deviceModel.findById(uplink.dev_id);
  if (dev.state !== "Sleep") {
    let aux = uplink.dev_id.split("_");
    const location = { sector: aux[0], identifier: aux[1] * 1 };
    if (state === 'Ocupado') {
      const start = new Date();
      const record = new recordModel({
        device: uplink.dev_id,
        state,
        battery,
        location,
        start
      });
      await record.save();
    } else {
      await recordModel.updateOne(
        { location: location, state: "Ocupado" },
        { end: Date.now(), state: "Libre" }
      );
    }
    await deviceModel.findByIdAndUpdate(uplink.dev_id, { state ,battery,lastKeepAlive: new Date()});
  } else console.log("Mensaje de dispositivo apagado");
};


const saveKeepAlive= async uplink=>{
  const dev_id=uplink.dev_id;
  const battery=uplink.battery;

  await deviceModel.findOneAndUpdate(
  {_id:dev_id},
  {lastKeepAlive:new Date(),battery:battery}
  )
}

const listen = io => {
  initIo(io);
  client.on("connect", () => {
    client.subscribe('parking/pub/+', (err, topic) => {
      client.on("message", async (topic, message) => {
        let uplink = format(message.toString());
        let aux = uplink.dev_id.split("_");
        if (uplink.port === 2) {
          await saveKeepAlive(uplink);
        } else {
          await saveRecord(uplink);
        }
        deviceModel.find({ "real_location.sector": aux[0] }, (err, list) => {
          io.in(aux[0]).emit("initial", list);
        });
      });
    });
  });
};

const sendDown = async (req, res) => {
  let device = req.body.device;
  client.publish(
      `parking/sub/${req.body.device._id}`,
      'changeMode',
      {
        retain: false,
        qos: 0
      }
    );

  let change=(device.state !== "Sleep")? "Sleep":"Libre";
  await deviceModel.findOneAndUpdate({_id:device._id},{state:change})
  const list=await deviceModel.find(
      { "real_location.sector": device.real_location.sector },
      { lastKeepAlive: 1, real_location: 1, state: 1, battery: 1 }).lean(false);
  let dateAux=new Date();
  let finalList=[];
  list.map(device=> {
    let auxDev = device.toObject();
    auxDev.lastSeen=Math.floor((dateAux.valueOf()-auxDev.lastKeepAlive.valueOf())/1000/60);
    finalList.push(auxDev);
  });
  res.status(200).send(finalList);

};

module.exports = { sendDown, listen };
