const https = require('https');

function callKersOne(scriptContent) {
  return new Promise((resolve, reject) => {
    const url = 'https://kers0ne-0bf.lovable.app/_serverFn/43850e3d124e7e45b168745acce9e83274bc95c5f678db56b9bf7d4640d67aec';
    
    // Construct Seroval payload
    const payload = {
      "t": {
        "t": 10,
        "i": 0,
        "p": {
          "k": ["data"],
          "v": [
            {
              "t": 10,
              "i": 1,
              "p": {
                "k": ["script"],
                "v": [
                  {
                    "t": 1,
                    "s": scriptContent
                  }
                ]
              },
              "o": 0
            }
          ]
        },
        "o": 0
      },
      "f": 63,
      "m": []
    };

    const dataString = JSON.stringify(payload);

    const options = {
      method: 'POST',
      headers: {
        'x-tsr-serverfn': 'true',
        'content-type': 'application/json',
        'accept': 'application/json, application/x-ndjson',
        'content-length': Buffer.byteLength(dataString)
      },
      timeout: 15000
    };

    const req = https.request(url, options, (res) => {
      let body = '';
      res.setEncoding('utf8');
      
      res.on('data', (chunk) => {
        body += chunk;
      });
      
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            const data = JSON.parse(body);
            const resultNode = data.p.v[0];
            const obfuscatedNode = resultNode.p.v[0];
            const obfuscatedScript = obfuscatedNode.s;
            resolve(obfuscatedScript);
          } catch (e) {
            reject(new Error(`Failed to parse Kers0ne response: ${e.message}`));
          }
        } else {
          reject(new Error(`Kers0ne returned status ${res.statusCode}`));
        }
      });
    });

    req.on('error', (e) => {
      reject(e);
    });

    req.write(dataString);
    req.end();
  });
}

function injectAntiDeobfuscation(obfuscatedScript) {
  const antiDeobfCode = `
	-- Hook detection and anti-deobfuscator code by Karmaforges
	local is_hooked = false
	local real_load = loadstring or load
	local getinfo = debug and debug.getinfo
	
	-- Verify if loadstring/load is hooked
	if getinfo then
		local info = getinfo(real_load)
		if info and info.what == "Lua" then
			is_hooked = true
		end
		
		-- Check if tostring is hooked
		local ts_info = getinfo(tostring)
		if ts_info and ts_info.what == "Lua" then
			is_hooked = true
		end
		
		-- Check if table.concat is hooked
		local tc_info = getinfo(table.concat)
		if tc_info and tc_info.what == "Lua" then
			is_hooked = true
		end
	end
	
	-- Check if tostring(real_load) doesn't contain standard function hex or signature
	if not tostring(real_load):find("function") or tostring(real_load) == "hooked" then
		is_hooked = true
	end
	
	-- Hook check 3: Verify environment consistency
	if getfenv and getfenv(0) ~= getfenv(1) then
		is_hooked = true
	end

	local f = function(src)
		if is_hooked then
			spawn(function()
				while true do
					print("skidder")
					task.wait(0.2)
				end
			end)
			return real_load("while true do print('skidder') task.wait(1) end")
		else
			return real_load(src)
		end
	end
  `;

  const targetPattern = /local\s+f\s*=\s*loadstring\s+or\s+load/;
  
  if (targetPattern.test(obfuscatedScript)) {
    return obfuscatedScript.replace(targetPattern, antiDeobfCode);
  } else {
    return `--[[
	Protected By Karmaforges Anti-Deobfuscation Shield
]]
local real_load = loadstring or load
local is_hooked = false
if debug and debug.getinfo then
	if debug.getinfo(real_load).what == "Lua" then is_hooked = true end
	if debug.getinfo(print).what == "Lua" then is_hooked = true end
end
if not tostring(real_load):find("function") then is_hooked = true end

if is_hooked then
	spawn(function()
		while true do
			print("skidder")
			task.wait(0.2)
		end
	end)
	return real_load("while true do print('skidder') task.wait(1) end")()
end

return (function(...)
${obfuscatedScript}
end)(...)`;
  }
}

async function obfuscateScript(scriptContent) {
  try {
    const rawObfuscated = await callKersOne(scriptContent);
    const fullyProtected = injectAntiDeobfuscation(rawObfuscated);
    return fullyProtected;
  } catch (e) {
    console.error('Error during script obfuscation:', e);
    return fallbackObfuscator(scriptContent);
  }
}

function fallbackObfuscator(scriptContent) {
  const key = Array.from({length: 16}, () => Math.floor(Math.random() * 256));
  const bytes = Buffer.from(scriptContent, 'utf8');
  const encryptedBytes = [];
  for (let i = 0; i < bytes.length; i++) {
    encryptedBytes.push(bytes[i] ^ key[i % key.length]);
  }
  
  const dStr = encryptedBytes.map(b => `\\${b.toString().padStart(3, '0')}`).join('');
  const keyStr = key.join(',');

  return `--[[
	Protected By Karmaforges Hybrid Protection
]]
return(function(...)
	local K={${keyStr}}
	local D="${dStr}"
	local B,C=string.byte,string.char
	
	local is_hooked = false
	local real_load = loadstring or load
	if debug and debug.getinfo then
		if debug.getinfo(real_load).what == "Lua" then is_hooked = true end
		if debug.getinfo(print).what == "Lua" then is_hooked = true end
	end
	if not tostring(real_load):find("function") then is_hooked = true end
	
	local X=(bit32 and bit32.bxor)or(bit and bit.bxor)or function(a,b)
		local r,p=0,1
		while a>0 or b>0 do
			local x,y=a%2,b%2
			if x~=y then r=r+p end
			a,b,p=(a-x)/2,(b-y)/2,p*2
		end
		return r
	end
	
	local f = function(src)
		if is_hooked then
			spawn(function()
				while true do
					print("skidder")
					task.wait(0.2)
				end
			end)
			return real_load("while true do print('skidder') task.wait(1) end")
		else
			return real_load(src)
		end
	end

	local o,n={},#D
	for i=1,n do o[i]=C(X(B(D,i),K[((i-1)%#K)+1])) end
	return f(table.concat(o))(...)
end)(...)`;
}

module.exports = {
  obfuscateScript,
  fallbackObfuscator
};
