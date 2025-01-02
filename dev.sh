#docker script

#stop running containers that relate to project
docker stop pepe-sql pepe_backend

#remove any containers and respective volumes(-v)
docker rm -v pepe-sql
docker rm pepe_backend

#remove old network if exists and create new one
docker network rm pepe-network
docker network create pepe-network

#build new backend image and push
docker build --platform linux/amd64,linux/arm64 -t braddev2/pepe_backend:latest .
docker push braddev2/pepe_backend:latest

# mysql script
docker pull mysql:latest
docker run --name pepe-sql \
  --network pepe-network \
  -e MYSQL_ROOT_PASSWORD=3353 \
  -e MYSQL_DATABASE=pepe_db \
  -p 3306:3306 \
  -v pepe-volume:/var/lib/mysql \
  -d mysql:latest

#backend script
docker pull braddev2/pepe_backend:latest
docker run --name pepe_backend \
  --network pepe-network \
  -p 5000:5000 \
  --mount type=bind,source="$(pwd)",target=/usr/src/app \
  -d braddev2/pepe_backend:latest



